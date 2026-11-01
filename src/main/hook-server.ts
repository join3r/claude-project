import http from 'http'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import {
  HOOK_TAB_ID_HEADER,
  HOOK_TOKEN_HEADER,
  MAX_HOOK_BODY_BYTES
} from '../shared/hook-protocol'

const VALID_ENDPOINTS = new Set(['session-start', 'working', 'stopped', 'notification', 'activity', 'context', 'land', 'update'])

/** Endpoints only answered (by the responder), never emitted: they ask DevTool something rather than report agent status. */
const REQUEST_ENDPOINTS = new Set(['context', 'land', 'update'])

/**
 * Endpoints that change git state. They take only the tab's own token
 * ({@link HookServer.tabToken}), never the shared one: the agent's note carries
 * it, so a token that leaks from a transcript or argv acts on that one task.
 */
const TAB_TOKEN_ENDPOINTS = new Set(['land', 'update'])

/**
 * Answers a hook with a body: `session-start` gets the agent's DevTool context
 * as Claude hook output, `context` the same note as text (Pi), `land` /
 * `update` run the task's landing for the agent. Undefined answers nothing.
 */
export type HookResponder = (endpoint: string, tabId: string, body: Record<string, unknown>) => Promise<string | undefined> | string | undefined

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name.toLowerCase()]
  if (Array.isArray(raw)) return raw[0]
  return raw
}

/** Constant-time compare so a local scanner cannot cheaply brute-force the token. */
export function hookTokensMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export class HookServer extends EventEmitter {
  private server: http.Server | null = null
  private port = 0
  private ready = false
  private logger?: (message: string) => void
  private token: string
  /** Keys {@link tabToken}. Never leaves this process: the shared token does (hook commands, Pi's env), so it can't key tab tokens. */
  private readonly tabSecret = crypto.randomBytes(32)
  private responder: HookResponder | null = null

  /** `logger` traces every inbound hook, including rejects — the only way to tell
   *  "the agent never called" from "it called with no tab id". */
  constructor(logger?: (message: string) => void) {
    super()
    this.logger = logger
    // One secret for this process. Pi and Claude both send it; SSH remotes reach
    // this server through the reverse forward, so the token is what stops a
    // random process on the remote from spoofing the inbox.
    this.token = crypto.randomBytes(32).toString('base64url')
  }

  getToken(): string {
    return this.token
  }

  /** The token only `tabId` may use, for {@link TAB_TOKEN_ENDPOINTS}: an HMAC of the tab id with a secret no agent sees. */
  tabToken(tabId: string): string {
    return crypto.createHmac('sha256', this.tabSecret).update(tabId).digest('base64url')
  }

  setResponder(responder: HookResponder | null): void {
    this.responder = responder
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const match = req.url?.match(/^\/hook\/(.+)$/)
        const endpoint = match?.[1]

        if (!endpoint || !VALID_ENDPOINTS.has(endpoint)) {
          this.logger?.(`hook reject-unknown url=${req.url}`)
          res.writeHead(404)
          res.end()
          return
        }

        if (req.method !== 'POST') {
          this.logger?.(`hook reject-method method=${req.method} endpoint=${endpoint}`)
          res.writeHead(405)
          res.end()
          return
        }

        const tabId = headerValue(req.headers, HOOK_TAB_ID_HEADER)
        if (!tabId) {
          // Means DEVTOOL_TAB_ID never reached the agent's env — the hook fired but
          // there is no tab to attribute it to.
          this.logger?.(`hook reject-no-tab-id endpoint=${endpoint}`)
          res.writeHead(400)
          res.end()
          return
        }

        const providedToken = headerValue(req.headers, HOOK_TOKEN_HEADER)
        const expected = TAB_TOKEN_ENDPOINTS.has(endpoint) ? this.tabToken(tabId) : this.token
        if (!hookTokensMatch(providedToken, expected)) {
          this.logger?.(`hook reject-unauthorized endpoint=${endpoint} tabId=${tabId}`)
          res.writeHead(401)
          res.end()
          return
        }

        let rawBody = ''
        let size = 0
        let tooLarge = false
        req.on('data', (chunk: Buffer | string) => {
          if (tooLarge || res.headersSent) return
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          size += buf.length
          if (size > MAX_HOOK_BODY_BYTES) {
            tooLarge = true
            this.logger?.(`hook reject-too-large endpoint=${endpoint} tabId=${tabId}`)
            res.writeHead(413)
            res.end()
            req.destroy()
            return
          }
          rawBody += buf.toString()
        })
        req.on('end', () => {
          if (tooLarge || res.headersSent) return

          let body: Record<string, unknown> = {}
          try { body = JSON.parse(rawBody) } catch { /* empty body is fine */ }

          this.logger?.(
            `hook endpoint=${endpoint} tabId=${tabId}` +
            (endpoint === 'activity' && typeof body.hook_event_name === 'string' ? ` event=${body.hook_event_name}` : '') +
            (typeof body.tool_name === 'string' ? ` tool=${body.tool_name}` : '') +
            (typeof body.notification_type === 'string' ? ` type=${body.notification_type}` : '') +
            (typeof body.message === 'string' ? ` message=${JSON.stringify(body.message)}` : '')
          )

          if (!REQUEST_ENDPOINTS.has(endpoint)) this.emit(endpoint, tabId, body)

          const responder = this.responder
          if (!responder) {
            res.writeHead(200)
            res.end()
            return
          }
          Promise.resolve()
            .then(() => responder(endpoint, tabId, body))
            .then(
              (answer) => {
                res.writeHead(200, answer ? { 'Content-Type': 'text/plain; charset=utf-8' } : {})
                res.end(answer ?? '')
              },
              (err: unknown) => {
                this.logger?.(`hook respond-error endpoint=${endpoint} tabId=${tabId} error=${err instanceof Error ? err.message : String(err)}`)
                res.writeHead(500)
                res.end()
              }
            )
        })
      })

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
        }
        this.ready = true
        resolve()
      })
    })
  }

  getPort(): number {
    return this.port
  }

  isReady(): boolean {
    return this.ready
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.ready = false
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }
}
