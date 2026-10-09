/**
 * Per-connection budget (§3.5): `rate` tokens per second, holding at most `burst`.
 * Phones `take` (refused when empty); desktops and servers `spend` into debt and are
 * throttled until the bucket is out of it (§3.10).
 */
export class TokenBucket {
  readonly #rate: number
  readonly #burst: number
  #tokens: number
  #at: number

  constructor(rate: number, burst: number, now: number) {
    this.#rate = rate
    this.#burst = burst
    this.#tokens = burst
    this.#at = now
  }

  #refill(now: number): void {
    if (now > this.#at) {
      this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#at) / 1000) * this.#rate)
      this.#at = now
    }
  }

  take(now: number): boolean {
    this.#refill(now)
    if (this.#tokens < 1) return false
    this.#tokens -= 1
    return true
  }

  /** Spends `n` tokens even if that leaves the bucket in debt; returns `waitMs`. */
  spend(n: number, now: number): number {
    this.#refill(now)
    this.#tokens -= n
    return this.waitMs(now)
  }

  /** Milliseconds until the bucket is out of debt; 0 when it isn't in debt. */
  waitMs(now: number): number {
    this.#refill(now)
    return this.#tokens >= 0 ? 0 : Math.ceil((-this.#tokens / this.#rate) * 1000)
  }
}

/**
 * New connections per IP in a sliding window (§3.5: 20 per minute). Connections that
 * are refused still count, so a client hammering the relay stays locked out until it
 * backs off.
 */
export class IpLimiter {
  readonly #limit: number
  readonly #windowMs: number
  readonly #hits = new Map<string, number[]>()

  constructor(limit: number, windowMs = 60_000) {
    this.#limit = limit
    this.#windowMs = windowMs
  }

  admit(ip: string, now: number): boolean {
    const since = now - this.#windowMs
    const hits = (this.#hits.get(ip) ?? []).filter((t) => t > since)
    hits.push(now)
    // Cap memory per IP: only the newest `limit + 1` hits matter for the decision.
    if (hits.length > this.#limit + 1) hits.splice(0, hits.length - this.#limit - 1)
    this.#hits.set(ip, hits)
    return hits.length <= this.#limit
  }

  /** Drops IPs with no hits in the window; call periodically. */
  prune(now: number): void {
    const since = now - this.#windowMs
    for (const [ip, hits] of this.#hits) {
      if (hits.every((t) => t <= since)) this.#hits.delete(ip)
    }
  }

  get size(): number {
    return this.#hits.size
  }
}
