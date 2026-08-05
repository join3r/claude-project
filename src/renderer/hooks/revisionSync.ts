import type { RevisionSaveResult } from '../../shared/types'

export type Updater<T> = (prev: T) => T

interface PendingEntry<T> {
  id: number
  /** Replaces an earlier unacknowledged entry with the same key (see `enqueue`). */
  key?: string
  updater: Updater<T>
}

export interface RevisionSyncOptions<T> {
  /** The compare-and-swap call into main. */
  save: (payload: { baseRevision: number; data: T }) => Promise<RevisionSaveResult<T>>
  /**
   * Push a rebased snapshot back into React state. Called whenever the client has had
   * to rebuild local state from main's canonical copy after a rejected save.
   */
  onRebase: (data: T) => void
  /** Retries exhausted, or the IPC itself threw. */
  onError: (message: string) => void
  /** Attempts per save cycle before giving up. */
  maxAttempts?: number
}

const DEFAULT_MAX_ATTEMPTS = 5

/**
 * The renderer half of the compare-and-swap.
 *
 * Every mutation is recorded as an updater — a pure function of the previous state —
 * before it is applied locally. That is the whole trick: when main refuses a save
 * because another window moved the revision on, recovery is mechanical. Take main's
 * canonical state, re-run the updaters that have not been acknowledged yet, and send
 * that. No structural diff, no merge heuristic, no guessing at array order.
 *
 * Saves are serialized. Two in-flight saves from one window would quote the same base
 * revision, so the second is refused for no reason at all — the CAS would be spending
 * its budget fighting this window rather than the other one.
 */
export class RevisionSyncClient<T> {
  private revision = 0
  private pending: PendingEntry<T>[] = []
  private nextId = 1
  /** Latest local snapshot waiting to go out; null when there is nothing to send. */
  private queued: T | null = null
  private inFlight: Promise<void> | null = null
  private readonly maxAttempts: number

  constructor(private readonly options: RevisionSyncOptions<T>) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  }

  /** Adopt the revision handed back by the initial load. */
  hydrate(revision: number): void {
    this.revision = revision
  }

  getRevision(): number {
    return this.revision
  }

  hasPending(): boolean {
    return this.pending.length > 0
  }

  isSaving(): boolean {
    return this.inFlight !== null
  }

  /**
   * Record a mutation. The caller applies the same updater to React state itself, so
   * several mutations can compose inside one event handler before anything is sent.
   *
   * `key` coalesces: a debounced content edit re-enqueued on every keystroke would
   * otherwise build a replay queue of stale intermediate values. The newest entry for
   * a key wins, and it closes over the newest value, so replaying only it is exactly
   * right.
   */
  enqueue(updater: Updater<T>, key?: string): void {
    if (key) this.pending = this.pending.filter(entry => entry.key !== key)
    this.pending.push({ id: this.nextId++, key, updater })
  }

  /** Re-run every unacknowledged mutation on top of `base`. */
  replay(base: T): T {
    let next = base
    for (const entry of this.pending) next = entry.updater(next)
    return next
  }

  /**
   * Canonical state pushed by main. Returns the state to adopt, or null when the
   * broadcast should be ignored.
   *
   * A broadcast that lands while a save is in flight is always ignored — it is either
   * the echo of our own save (replaying our still-unacknowledged updaters onto it
   * would apply them twice) or another window's write, which the in-flight CAS is
   * about to reject and hand us properly. Either way the compare-and-swap is the
   * safety net, so dropping the message costs at most one extra round trip.
   */
  applyBroadcast(revision: number, data: T): T | null {
    if (this.inFlight) return null
    this.revision = revision
    return this.replay(data)
  }

  /** Queue the current local snapshot for saving. */
  requestSave(data: T): void {
    this.queued = data
    if (!this.inFlight) this.run()
  }

  /** Resolves once no save is in flight and nothing is queued. Tests await this. */
  async settled(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight
    }
  }

  private run(): void {
    // Only ever one of these alive at a time — `requestSave` starts a run solely when
    // none is in flight, and `loop` drains everything queued behind it.
    this.inFlight = this.loop().finally(() => {
      this.inFlight = null
    })
  }

  private async loop(): Promise<void> {
    while (this.queued !== null) {
      const data = this.queued
      this.queued = null
      await this.attempt(data)
    }
  }

  private async attempt(initial: T): Promise<void> {
    let data = initial

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      // Snapshot which mutations this payload carries. Anything enqueued while the
      // IPC is in flight is not covered by it and has to stay pending.
      const carried = new Set(this.pending.map(entry => entry.id))

      let result: RevisionSaveResult<T>
      try {
        result = await this.options.save({ baseRevision: this.revision, data })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.options.onError(`Could not save changes: ${message}`)
        return
      }

      if (result.ok) {
        this.revision = result.revision
        this.pending = this.pending.filter(entry => !carried.has(entry.id))
        return
      }

      this.revision = result.revision

      if (attempt === this.maxAttempts) {
        // Another window is writing continuously. Adopting canonical state *without*
        // the replay is the only outcome that both converges and stays honest: the
        // local edits are gone, and the user is told so rather than left watching a
        // retry loop that never lands.
        this.pending = []
        this.queued = null
        this.options.onRebase(result.data)
        this.options.onError(
          `Could not save changes after ${this.maxAttempts} attempts because another window kept writing first. This window was reloaded from the saved state; the last changes made here were lost.`
        )
        return
      }

      data = this.replay(result.data)
      this.options.onRebase(data)
      // The rebase is not a fresh local change: letting it queue a trailing send
      // would keep re-sending the same payload after this attempt succeeds.
      this.queued = null
    }
  }
}
