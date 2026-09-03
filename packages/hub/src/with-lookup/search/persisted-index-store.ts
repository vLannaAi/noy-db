/**
 * Persisted backend for the L1 lexical index (L1.5). Crypto-free: the
 * collection injects load/save/remove + a fingerprint provider. In-memory while
 * live (L1 behavior); persists an opaque snapshot via a debounced flush, and
 * validates a loaded blob against a {count,maxVersion} fingerprint so a stale
 * blob is never used — only rebuilt.
 *
 * #725: a debounced save (encrypt + adapter.put) racing a purge (removePersisted,
 * called by elevate's tier purge and forget's erasure) is guarded by an epoch counter
 * — see the `epoch` field doc for the mechanism and why it also closes the issue's
 * variant (b) for free. Residual gap, structurally unavoidable without a durable
 * write-ahead log: a process CRASH strictly between a stale save's `adapter.put`
 * landing and its compensating `remove()` running (or between the compensating
 * remove landing and `pendingCompensation` being persisted somewhere durable — it is
 * in-memory only) leaves the resurrected blob at rest until the next natural
 * rebuild-persist. This is on par with the gate-before-put optimization's own crash
 * residual (a crash between `isStale()` returning false and the put landing) — both
 * are eliminated only by making the purge and the save's commit point transactional
 * with the store, which is out of scope for an in-memory debounce layer over an
 * arbitrary opaque-blob backend.
 */
import { InvertedIndex, type IndexDoc, type IndexBuildOptions } from './inverted-index.js'
import { serializeIndex, deserializeIndex } from './serialize.js'
import type { IndexStore } from './index-store.js'
import { PersistedIndexCompensationError } from '../../kernel/errors.js'

export interface Fingerprint { readonly count: number; readonly maxVersion: number }

export interface PersistedIndexCallbacks {
  load(): Promise<{ json: string; fingerprint: Fingerprint } | null>
  /** `isStale()` reflects whether a purge (removePersisted) has landed since this
   *  save's epoch was captured — check it AFTER any async encrypt step and BEFORE
   *  the actual adapter.put, skipping the write when true (#725 review: shrinks the
   *  at-rest window for purge-beats-encrypt orderings to zero). Belt-and-suspenders:
   *  PersistedIndexStore's own post-save epoch check (persist(), below) is the
   *  backstop that catches every other ordering, including a purge landing during
   *  the put itself. */
  save(json: string, fp: Fingerprint, isStale: () => boolean): Promise<void>
  remove(): Promise<void>
  currentFingerprint(): Fingerprint
  debounceMs?: number
}

function fpEqual(a: Fingerprint, b: Fingerprint): boolean {
  return a.count === b.count && a.maxVersion === b.maxVersion
}

/** Set equality between a loaded index's positional fields and the live opt-in (#1354). */
function positionsMatch(idx: InvertedIndex, opts: IndexBuildOptions | undefined): boolean {
  const want = new Set(opts?.positions ?? [])
  const have = idx.positionFields
  if (want.size !== have.size) return false
  for (const f of want) if (!have.has(f)) return false
  return true
}

export class PersistedIndexStore implements IndexStore {
  private index: InvertedIndex | undefined
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastBuild: (() => ReadonlyArray<IndexDoc>) | undefined
  /** The positional-postings opt-in the last caller asked for (#1354). A loaded
   *  sidecar that does not carry exactly these fields is discarded, not adapted. */
  private lastOpts: IndexBuildOptions | undefined
  private readonly debounceMs: number
  /**
   * Bumped by every purge (removePersisted). A save() captured under a since-stale
   * epoch undoes its own effect once it settles, however it interleaves with the
   * purge's own delete — a delete can never be overtaken by a save that was
   * scheduled before it (#725).
   *
   * Subsumes the issue's variant (b) (a stale, pre-purge in-memory index getting
   * paired with a live, post-purge fingerprint and TRUSTED by a cold load, defeating
   * the fingerprint backstop) for free — no separate handling needed: removePersisted()
   * always resets `index` to undefined in the SAME synchronous step that bumps the
   * epoch (below), and the only two paths that can repopulate `index` (ensureBuilt's
   * cold rebuild, rebuildAndPersist's rebuild) do so strictly from `lastBuild()`, which
   * the collection wires to read its LIVE cache at call time — not a frozen snapshot.
   * Cache eviction (the collection dropping the purged/forgotten record) always
   * precedes removePersisted() in both the elevate and forget call paths (#721's
   * syncCache eviction / forget's tombstone write both land before syncSearch /
   * _purgeSearchIndex runs). So any rebuild that executes strictly after
   * removePersisted() — the only way `index` becomes defined again post-purge —
   * necessarily observes the post-purge cache, and any rebuild that predates
   * removePersisted() has its `index` wiped by it. There is no ordering in which a
   * stale (pre-purge) index survives to be skip-rebuilt and persisted under a
   * matching live fingerprint. Regression-pinned in
   * `search-persisted-index-store.test.ts` ("variant (b) is subsumed...").
   */
  private epoch = 0
  /**
   * Set when a compensating/purging remove() (`compensate()` undoing a stale
   * save, or `removePersisted()`'s own purge, #764) fails. Unlike the routine
   * best-effort swallow on the debounced flush path (markDirty's timer
   * .catch(), below — safe there because the fingerprint backstop forces a
   * rebuild on the next cold load), a failed removal leaves a resurrected or
   * un-purged blob at rest whose fingerprint can still match the live cache —
   * a cold load would TRUST it, not rebuild past it. So this is never silently
   * dropped: every subsequent store entrypoint (ensureBuilt, rebuildAndPersist,
   * removePersisted) retries the remove first and refuses to proceed past it
   * until it succeeds (#725 review), and the raw adapter error is wrapped in
   * {@link PersistedIndexCompensationError} (#764) so a caller can catch a
   * stuck removal deliberately instead of an indistinguishable adapter error.
   * A crash between a landed put and its compensating remove (before this
   * flag or a retry can run) is a residual gap — see the class doc.
   */
  private pendingCompensation = false

  constructor(private readonly cb: PersistedIndexCallbacks) {
    this.debounceMs = cb.debounceMs ?? 1000
  }

  get built(): boolean { return this.index !== undefined }

  async ensureBuilt(build: () => ReadonlyArray<IndexDoc>, opts?: IndexBuildOptions): Promise<InvertedIndex> {
    await this.retryPendingCompensation()
    this.lastBuild = build
    this.lastOpts = opts
    if (this.index !== undefined) return this.index
    const loaded = await this.cb.load()
    if (loaded !== null && fpEqual(loaded.fingerprint, this.cb.currentFingerprint())) {
      // Four independent reasons to rebuild instead, in the #1359 posture: the
      // blob does not parse, it is stamped for another format, it is internally
      // inconsistent, or its positional coverage is not the coverage the live
      // config asks for (a collection that just opted a field into
      // `textIndexPositions` must not keep answering from the position-free blob).
      const restored = deserializeIndex(loaded.json)
      if (restored !== null && positionsMatch(restored, opts)) {
        this.index = restored
        return this.index
      }
    }
    this.index = InvertedIndex.build(build(), opts)
    await this.persist()
    return this.index
  }

  markDirty(): void {
    this.index = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      // Best-effort: an ordinary save failure here is fine (the fingerprint backstop
      // forces a rebuild on the next cold load). A failed COMPENSATION is different —
      // it sets pendingCompensation (see field doc) instead of relying on this
      // swallow, and is retried — not dropped — by whichever store operation runs next.
      void this.rebuildAndPersist().catch(() => { /* best-effort flush; fingerprint backstop forces rebuild next load */ })
    }, this.debounceMs)
  }

  /** Force an immediate persist (cancels any pending debounce). */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    await this.rebuildAndPersist()
  }

  /** Delete the persisted blob and drop the in-memory index (forget/erasure/tier
   *  move). A failed purge is wrapped in {@link PersistedIndexCompensationError}
   *  (#764) and left sticky (`pendingCompensation`) so the next store entrypoint
   *  retries it — never silently dropped, same posture #725 established for a
   *  stale save's own compensating remove. */
  async removePersisted(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    await this.retryPendingCompensation()
    this.epoch++ // any save() already in flight is now stale — it will self-undo
    this.index = undefined
    try {
      await this.cb.remove()
      this.pendingCompensation = false
    } catch (e) {
      this.pendingCompensation = true
      throw new PersistedIndexCompensationError(e)
    }
  }

  /** Rebuild using the last known build thunk, then persist. */
  private async rebuildAndPersist(): Promise<void> {
    await this.retryPendingCompensation()
    if (this.lastBuild === undefined) return
    if (this.index === undefined) {
      this.index = InvertedIndex.build(this.lastBuild(), this.lastOpts)
    }
    await this.persist()
  }

  /** Persist the current index, then undo it if a purge (removePersisted) landed
   *  while the save was in flight — a delete can never be overtaken by a save
   *  that was scheduled before it (#725). A failed undo does not silently vanish:
   *  see `pendingCompensation`. */
  private async persist(): Promise<void> {
    if (this.index === undefined) return
    const epoch = this.epoch
    await this.cb.save(serializeIndex(this.index), this.cb.currentFingerprint(), () => this.epoch !== epoch)
    if (this.epoch !== epoch) await this.compensate()
  }

  /** Undo a stale save. Failure is sticky, not swallowed: see `pendingCompensation`.
   *  Wraps the raw adapter error in {@link PersistedIndexCompensationError} (#764) so
   *  a caller (e.g. the tier ops' `syncTierSearch`) can catch a stuck compensation
   *  deliberately instead of treating it as an indistinguishable adapter failure. */
  private async compensate(): Promise<void> {
    try {
      await this.cb.remove()
      this.pendingCompensation = false
    } catch (e) {
      this.pendingCompensation = true
      throw new PersistedIndexCompensationError(e)
    }
  }

  /** Retries a sticky compensation before any store entrypoint proceeds. Failure
   *  re-wraps the raw adapter error the same way `compensate()` does (#764) — the
   *  flag stays set (untouched here) so the NEXT entrypoint retries again. */
  private async retryPendingCompensation(): Promise<void> {
    if (!this.pendingCompensation) return
    try {
      await this.cb.remove()
      this.pendingCompensation = false
    } catch (e) {
      throw new PersistedIndexCompensationError(e)
    }
  }
}
