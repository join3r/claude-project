import { net } from 'electron'

export interface RedirectProbe {
  status: number
  /** Where the server redirected to, or null when it answered without a redirect. */
  location: string | null
}

/**
 * One request that stops at the first redirect and reports where it pointed.
 * Electron's `net` (Chromium's network stack) rather than Node's fetch: it uses
 * the system proxy / PAC settings and Chromium's IPv6 fallback — Node's fetch
 * hung for the full timeout on a Windows box's first request. `net.fetch` cannot
 * do this: with `redirect: 'manual'` it rejects ("Redirect was cancelled").
 */
export function probeRedirect(url: string, timeoutMs = 30_000): Promise<RedirectProbe> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'manual' })
    const timer = setTimeout(() => {
      request.abort()
      reject(new Error(`No answer from ${new URL(url).host} within ${timeoutMs / 1000} s`))
    }, timeoutMs)
    const settle = (result: RedirectProbe) => {
      clearTimeout(timer)
      resolve(result)
      request.abort()
    }
    request.on('redirect', (status, _method, location) => settle({ status, location }))
    request.on('response', (response) => settle({ status: response.statusCode, location: null }))
    request.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    request.end()
  })
}
