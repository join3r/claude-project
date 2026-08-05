import type { RevisionEnvelope, RevisionSaveResult } from '../shared/types'

export interface RevisionStoreOptions<T> {
  /** The canonical value as read off disk at startup. */
  initial: T
  /** Applied to every value that is about to become canonical. */
  normalize?: (data: T) => T
  /** Write the new canonical value to disk. */
  persist: (data: T) => void
  /** Tell every window about the new canonical value. */
  broadcast: (envelope: RevisionEnvelope<T>) => void
}

function structuralClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * The canonical copy of a piece of shared state, guarded by a revision counter.
 *
 * Windows do not send deltas — they send whole snapshots — so the only way to tell
 * "this window has seen everything" from "this window is about to erase someone's
 * work" is to make it name the revision it started from. A save that names the
 * current revision wins and bumps it; anything else is refused and handed the
 * canonical state back to rebase onto.
 *
 * `commit` is the same write path for changes main makes on its own behalf, so
 * those also bump the revision and broadcast rather than sliding in unnoticed.
 */
export class RevisionStore<T> {
  private revision = 0
  private data: T

  constructor(private readonly options: RevisionStoreOptions<T>) {
    this.data = options.normalize ? options.normalize(options.initial) : options.initial
  }

  /** The canonical value plus the revision a save must quote to be accepted. */
  get(): RevisionEnvelope<T> {
    return { revision: this.revision, data: structuralClone(this.data) }
  }

  /** Read-only access for main's own bookkeeping. Never hand this out to IPC. */
  peek(): T {
    return this.data
  }

  getRevision(): number {
    return this.revision
  }

  /**
   * Unconditional write from main itself. Nothing in main holds a stale snapshot
   * long enough for a CAS to be meaningful, but the revision bump and broadcast
   * are what keep the renderers honest, so every main-side mutation goes here.
   */
  commit(next: T): RevisionEnvelope<T> {
    this.data = this.options.normalize ? this.options.normalize(next) : next
    this.revision += 1
    this.options.persist(this.data)
    const envelope = this.get()
    this.options.broadcast(envelope)
    return envelope
  }

  /** Compare-and-swap from a renderer. Nothing is persisted when the base is stale. */
  save(baseRevision: number, data: T): RevisionSaveResult<T> {
    if (baseRevision !== this.revision) {
      return { ok: false, revision: this.revision, data: structuralClone(this.data) }
    }
    const envelope = this.commit(data)
    return { ok: true, revision: envelope.revision }
  }
}
