import http from 'http'
import { EventEmitter } from 'events'

const VALID_ENDPOINTS = new Set(['session-start', 'working', 'stopped', 'notification'])

export class HookServer extends EventEmitter {
  private server: http.Server | null = null
  private port = 0
  private ready = false
  private logger?: (message: string) => void

  /** `logger` traces every inbound hook, including rejects — the only way to tell
   *  "the agent never called" from "it called with no tab id". */
  constructor(logger?: (message: string) => void) {
    super()
    this.logger = logger
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

        const tabId = req.headers['x-tab-id'] as string | undefined
        if (!tabId) {
          // Means DEVTOOL_TAB_ID never reached the agent's env — the hook fired but
          // there is no tab to attribute it to.
          this.logger?.(`hook reject-no-tab-id endpoint=${endpoint}`)
          res.writeHead(400)
          res.end()
          return
        }

        let rawBody = ''
        req.on('data', (chunk) => { rawBody += chunk })
        req.on('end', () => {
          let body: Record<string, unknown> = {}
          try { body = JSON.parse(rawBody) } catch { /* empty body is fine */ }

          this.logger?.(
            `hook endpoint=${endpoint} tabId=${tabId}` +
            (typeof body.message === 'string' ? ` message=${JSON.stringify(body.message)}` : '')
          )

          if (endpoint === 'working' || endpoint === 'stopped') {
            this.emit(endpoint, tabId)
          } else {
            this.emit(endpoint, tabId, body)
          }

          res.writeHead(200)
          res.end()
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
