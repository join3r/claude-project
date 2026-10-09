#!/usr/bin/env node
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import type { PushSenderConfig, RelayConfig } from './config.ts'
import { createLogger } from './log.ts'
import type { Logger } from './log.ts'
import { createApnsSender, createLogSender, createSimctlSender, loadApnsKey } from './push/apns.ts'
import type { ApnsSender } from './push/apns.ts'
import { createPushGateway } from './push/gateway.ts'
import type { PushGateway } from './push/gateway.ts'
import { startRelayServer } from './server.ts'
import { SqliteStore } from './store.ts'

/**
 * Entry point: `node src/main.ts` (Node >= 24 strips the types itself; no build step).
 * Configuration comes from the environment, see README.md.
 */

function fatal(message: string): never {
  process.stderr.write(`relay: ${message}\n`)
  process.exit(1)
}

function createSender(sender: PushSenderConfig, log: Logger): ApnsSender {
  switch (sender.mode) {
    case 'apns':
      return createApnsSender({ key: loadApnsKey(sender.keyFile), keyId: sender.keyId, teamId: sender.teamId, topic: sender.topic, logger: log })
    case 'simctl':
      return createSimctlSender({ device: sender.device, topic: sender.topic, logger: log })
    case 'log':
      return createLogSender(log)
  }
}

let config: RelayConfig
try {
  config = loadConfig()
} catch (err) {
  fatal((err as Error).message)
}
const log = createLogger(config.logLevel)
const dbPath = join(config.dataDir, 'relay.db')
const store = new SqliteStore(dbPath)

let gateway: PushGateway | undefined
if (config.push.role === 'gateway') {
  const senderConfig = config.push.sender
  let sender: ApnsSender
  try {
    sender = createSender(senderConfig, log)
  } catch (err) {
    fatal((err as Error).message)
  }
  gateway = createPushGateway({ store, sealKey: config.push.sealKey, sender, logger: log })
  const detail =
    senderConfig.mode === 'apns'
      ? { keyId: senderConfig.keyId, teamId: senderConfig.teamId, topic: senderConfig.topic }
      : senderConfig.mode === 'simctl'
        ? { simulator: senderConfig.device, topic: senderConfig.topic }
        : {}
  log.info('push-gateway', { mode: senderConfig.mode, ...detail })
} else if (config.push.role === 'forward') {
  log.info('push-forward', { upstream: config.push.upstream })
} else {
  log.info('push-off')
}

const server = await startRelayServer({
  store,
  port: config.port,
  host: config.host,
  trustProxy: config.trustProxy,
  logger: log,
  gateway,
  pushUpstream: config.push.role === 'forward' ? config.push.upstream : undefined,
  limits: config.limits
})
log.info('listening', { host: config.host, port: server.port, db: dbPath, trustProxy: config.trustProxy, ...config.limits })

let stopping = false
async function stop(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log.info('shutting-down', { signal })
  const hard = setTimeout(() => {
    log.warn('shutdown-timeout')
    process.exit(1)
  }, 10_000)
  hard.unref()
  try {
    await server.close()
  } finally {
    gateway?.close()
    store.close()
    log.info('stopped')
    process.exit(0)
  }
}

process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))
process.on('uncaughtException', (err) => {
  log.error('uncaught', { error: err.message, stack: err.stack })
  process.exit(1)
})
