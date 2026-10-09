import { HostServices } from '../main/host/host-services'
import { ClientRegistry } from './client-registry'
import { ProcessPowerSave } from './power-save'
import { createServerHostEnv, ensureServerDirs, type ServerHostEnv, type ServerManifest, type ServerPaths } from './server-env'
import type { PowerSaveApi } from '../main/sleep-blocker'

export interface ServerHostOptions {
  paths: ServerPaths
  manifest: ServerManifest
  /** The bundle's dir, where the resources are. */
  bundleDir: string
  log: (message: string) => void
  /** Defaults to {@link ProcessPowerSave}. */
  powerSave?: PowerSaveApi
}

/** A running server host: the {@link HostServices} and the {@link ClientRegistry} in front of it. */
export interface ServerHost {
  host: HostServices
  /** Register clients here and call the host's channels as them. */
  clients: ClientRegistry
  env: ServerHostEnv
  /** What the desktop does on quit: PTYs and chats stopped, scrollback saved, the hook server closed. */
  shutdown(): Promise<void>
}

/**
 * The host with the server's Node adapters, started and with every host IPC
 * channel registered on the client registry. No transport: whoever starts it
 * registers clients (the host link in the daemon, a test in process).
 *
 * Phones stay off: the MobileService is built but dormant, as on a desktop
 * with Mobile off (the server's config has it off until it pairs phones).
 */
export async function startServerHost(options: ServerHostOptions): Promise<ServerHost> {
  ensureServerDirs(options.paths)
  const env = createServerHostEnv({
    paths: options.paths,
    manifest: options.manifest,
    bundleDir: options.bundleDir,
    powerSave: options.powerSave ?? new ProcessPowerSave({ log: options.log }),
    log: options.log
  })
  let host: HostServices | null = null
  const clients = new ClientRegistry({
    onClientGone: (clientId) => host?.detachClient(clientId),
    log: env.log
  })
  host = new HostServices({ env, clients })
  await host.start()
  host.registerIpcHandlers(clients.createRegistrar(env.log))

  const started = host
  let stopped: Promise<void> | null = null
  return {
    host: started,
    clients,
    env,
    shutdown: () => {
      stopped ??= started.shutdown()
      return stopped
    }
  }
}
