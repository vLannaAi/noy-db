/**
 * Per-refresh emit diffing for materialized views (#1418).
 *
 * ## What was actually slow
 *
 * The issue reads like a folding problem — "the live grouped aggregate is
 * incrementally maintained at 0.26 ms, the MV recomputes everything" — and the
 * obvious move is to reach for `GroupedMaintainer` (#1341). Measured first, it
 * is not where the time goes. A single source write into a UNION MV over ~200
 * receipts / 100 output rows cost, per write:
 *
 *   - **100 store puts** — every MV output row re-encrypted and re-written,
 *     whether or not its content changed;
 *   - **100 store gets + 100 record DECRYPTS** — the `onEmpty: 'delete'`
 *     tombstone pass listing every id in the output collection and decoding
 *     each one to read its `_materializedFrom` ownership stamp;
 *   - one in-memory scan + map + fold over the sources, served entirely from
 *     the collection record cache (**zero** store reads).
 *
 * AES-GCM per row, twice, times every row in the view. The fold was noise. So
 * the win is not a cheaper fold — it is **not writing rows that did not
 * change, and not decrypting rows to ask a question we already know the answer
 * to**. That is what this module does, and it is why the row *set* the
 * executor computes is left exactly as it was: the rows are still produced by
 * one full recompute, so the materialised result is bit-identical to the
 * pre-#1418 result by construction, not by argument. (#1341's own reason for
 * re-folding a dirty bucket from its records rather than inverting reducers —
 * float `sum` is not invertible — applies here a fortiori: nothing is
 * inverted, nothing is patched, the reducers never see a delta.)
 *
 * ## The two skips, and what makes each one safe
 *
 * **1. The write skip.** Keyed by output-row id, this cache remembers the
 * fingerprint of the row we last emitted AND the output collection's record
 * version immediately after that write. A put is skipped only when the new
 * row's fingerprint matches AND the collection's currently-cached version for
 * that id still equals the one we recorded. The version guard is what makes
 * the entry self-verifying: every write through `Collection` bumps `_v`, so a
 * user overwrite, a delete, an elevation, another MV, or a rollback all move
 * the version and force a rewrite. Nothing invalidates this cache from the
 * outside because nothing has to.
 *
 * It is read from the collection's own eager record cache — the same basis the
 * MV's source scan already trusts, and the same one `Collection.get()` answers
 * from. A **lazy** (LRU) output collection reports no version, so every row is
 * written exactly as before: a miss is always "write it".
 *
 * **2. The tombstone scope.** The full pass exists to find output rows this MV
 * emitted earlier and no longer emits. Once we have vouched-for knowledge of
 * the id set we emitted, the candidates are `emitted \ current` — usually
 * empty — instead of every id in the output collection. The FIRST refresh of a
 * session always runs the full scan, so residue left by an earlier session is
 * still swept; only afterwards does the scope narrow. Any refresh that throws
 * mid-pass drops the knowledge and the next one scans fully again.
 *
 * ## The fallback is observable, deliberately
 *
 * #1341's lesson: a fallback that silently swallows every case passes every
 * behavioural test while delivering nothing. {@link MvEmitCache.stats} counts
 * both paths on both axes — `rowsWritten` vs `rowsUnchanged`, and
 * `fullTombstoneScans` vs `scopedTombstoneScans` — plus
 * `fingerprintFailures`, the rows this module refused to vouch for. A test
 * asserts WHICH path ran, not merely that the answer was right.
 *
 * @internal
 */

/** Counters exposed by {@link MvEmitCache.stats} — cumulative per registered MV. */
export interface MvMaintenanceStats {
  /** Refresh passes started. */
  readonly refreshes: number
  /** Output rows actually put to the store. */
  readonly rowsWritten: number
  /** Output rows whose put was elided because content and version both matched. */
  readonly rowsUnchanged: number
  /** Tombstone passes that listed the whole output collection. */
  readonly fullTombstoneScans: number
  /** Tombstone passes that considered only this MV's own previously-emitted ids. */
  readonly scopedTombstoneScans: number
  /** Rows this module could not fingerprint, and therefore always rewrites. */
  readonly fingerprintFailures: number
}

interface EmittedRow {
  readonly fingerprint: string
  readonly version: number
}

/**
 * Canonical, key-sorted serialization of one materialized row, used only to
 * answer "is this the same row we emitted last time".
 *
 * Returns `null` for anything it cannot vouch for — a bigint, a function, a
 * symbol, a cycle, or a class instance that would not round-trip through the
 * record codec the way a plain object does. `null` means "always write", which
 * is exactly the pre-#1418 behaviour, and it is counted.
 *
 * Ordinary JSON value semantics are deliberate elsewhere: `NaN`, `Infinity`
 * and `-0` all collapse the same way the stored `_data` payload collapses
 * them, so two rows with equal fingerprints have equal stored bytes. That is
 * the only property this function needs.
 */
export function fingerprintRow(row: Record<string, unknown>): string | null {
  const seen = new Set<unknown>()
  const write = (value: unknown, out: string[]): boolean => {
    if (value === null) { out.push('null'); return true }
    switch (typeof value) {
      case 'string': out.push(JSON.stringify(value)); return true
      case 'number': out.push(Number.isFinite(value) ? String(value) : 'null'); return true
      case 'boolean': out.push(value ? 'true' : 'false'); return true
      case 'undefined': out.push('#u'); return true
      case 'bigint': case 'function': case 'symbol': return false
      default: break
    }
    if (seen.has(value)) return false
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        out.push('[')
        for (const item of value) { if (!write(item, out)) return false; out.push(',') }
        out.push(']')
        return true
      }
      // Anything that is not a plain object (Date, Map, Set, a class instance)
      // is refused rather than guessed at — its stored form is decided by the
      // record codec, not by us.
      const proto = Object.getPrototypeOf(value) as unknown
      if (proto !== Object.prototype && proto !== null) return false
      out.push('{')
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out.push(JSON.stringify(key), ':')
        if (!write((value as Record<string, unknown>)[key], out)) return false
        out.push(',')
      }
      out.push('}')
      return true
    } finally {
      seen.delete(value)
    }
  }
  const out: string[] = []
  return write(row, out) ? out.join('') : null
}

/**
 * One refresh pass over an MV's output. Created by {@link MvEmitCache.begin},
 * closed by {@link EmitPass.commit}. A pass that is never committed — because
 * the refresh threw — leaves the cache with no vouched-for id set, so the next
 * refresh falls back to the full tombstone scan.
 */
export class EmitPass {
  private readonly next = new Map<string, EmittedRow>()
  private readonly ids = new Set<string>()
  /** Every emitted id landed in {@link ids}; nothing was lost to a failed write. */
  private complete = true

  constructor(
    private readonly owner: MvEmitCache,
    private readonly prior: ReadonlyMap<string, EmittedRow>,
    private readonly priorIds: ReadonlySet<string> | null,
  ) {}

  /**
   * The ids to consider for tombstoning, or `null` when the full output
   * collection must be listed. Non-null only once a previous pass has run to
   * completion after a full scan.
   */
  tombstoneScope(): ReadonlySet<string> | null {
    if (this.priorIds === null) { this.owner._countFullScan(); return null }
    this.owner._countScopedScan()
    return this.priorIds
  }

  /**
   * May the put for `id` be elided? True only when the row is byte-equal to
   * the one we emitted AND the output collection still holds exactly the
   * version our write produced.
   */
  trySkip(id: string, fingerprint: string | null, currentVersion: number | undefined): boolean {
    if (fingerprint === null) { this.owner._countFingerprintFailure(); return false }
    if (currentVersion === undefined) return false
    const p = this.prior.get(id)
    if (p === undefined || p.fingerprint !== fingerprint || p.version !== currentVersion) return false
    this.next.set(id, p)
    this.ids.add(id)
    this.owner._countUnchanged()
    return true
  }

  /** Record a row we actually wrote. `versionAfter` is read back post-put. */
  wrote(id: string, fingerprint: string | null, versionAfter: number | undefined): void {
    this.owner._countWritten()
    this.ids.add(id)
    if (fingerprint !== null && versionAfter !== undefined) {
      this.next.set(id, { fingerprint, version: versionAfter })
    }
  }

  /**
   * A row that was NOT written — a failed write, or a `putDerivedOutput`
   * frozen-period decline. It is not ours, so it must not be skippable next
   * time and must not be counted as one of our emitted ids.
   */
  notEmitted(id: string): void {
    this.next.delete(id)
    this.ids.delete(id)
  }

  /** A tombstoned id leaves the emitted set. */
  removed(id: string): void {
    this.next.delete(id)
    this.ids.delete(id)
  }

  /** Something went wrong that makes the emitted-id set unreliable. */
  lostTrack(): void {
    this.complete = false
  }

  /**
   * Publish this pass's knowledge. `scannedFully` says whether the tombstone
   * pass listed the whole output collection — only then does the emitted-id
   * set cover residue from earlier sessions, and only then may a LATER pass
   * scope its scan. `onEmpty: 'keep'` never scans, so it never earns scoping.
   */
  commit(scannedFully: boolean): void {
    this.owner._commit(this.next, this.complete && (scannedFully || this.priorIds !== null) ? this.ids : null)
  }
}

/**
 * The per-MV emit cache. One instance per {@link RegisteredMV}, held for the
 * life of the vault — see {@link emitCacheFor}.
 */
export class MvEmitCache {
  private emitted = new Map<string, EmittedRow>()
  private emittedIds: Set<string> | null = null

  private refreshes = 0
  private rowsWritten = 0
  private rowsUnchanged = 0
  private fullTombstoneScans = 0
  private scopedTombstoneScans = 0
  private fingerprintFailures = 0

  stats(): MvMaintenanceStats {
    return {
      refreshes: this.refreshes,
      rowsWritten: this.rowsWritten,
      rowsUnchanged: this.rowsUnchanged,
      fullTombstoneScans: this.fullTombstoneScans,
      scopedTombstoneScans: this.scopedTombstoneScans,
      fingerprintFailures: this.fingerprintFailures,
    }
  }

  /**
   * Open a pass. The vouched-for id set is dropped up front and restored only
   * by {@link EmitPass.commit}, so a refresh that throws mid-flight cannot
   * leave behind a set that under-covers the rows it managed to write.
   */
  begin(): EmitPass {
    this.refreshes++
    const priorIds = this.emittedIds
    this.emittedIds = null
    return new EmitPass(this, this.emitted, priorIds)
  }

  /** @internal */ _commit(next: Map<string, EmittedRow>, ids: Set<string> | null): void {
    this.emitted = next
    this.emittedIds = ids
  }
  /** @internal */ _countWritten(): void { this.rowsWritten++ }
  /** @internal */ _countUnchanged(): void { this.rowsUnchanged++ }
  /** @internal */ _countFullScan(): void { this.fullTombstoneScans++ }
  /** @internal */ _countScopedScan(): void { this.scopedTombstoneScans++ }
  /** @internal */ _countFingerprintFailure(): void { this.fingerprintFailures++ }
}

/**
 * Read the version the output collection currently holds for `id`, from the
 * collection's own eager record cache.
 *
 * Reaches a private field through `any` for the same reason the executor
 * already reaches `adapter` / `vault` / `_decodeEnvelope` that way:
 * `kernel/collection.ts` sits at its kernel-surface line ceiling with no
 * headroom, and an accessor there would buy nothing this comment does not.
 *
 * `undefined` — a lazy (LRU) collection, or a cold id — means "no opinion",
 * and every caller treats no opinion as "write the row".
 *
 * @internal
 */
export function cachedVersionReader(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outputColl: any,
): (id: string) => number | undefined {
  const cache = outputColl?.cache as Map<string, { version: number }> | undefined
  if (!(cache instanceof Map)) return () => undefined
  return (id: string) => cache.get(id)?.version
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const caches = new WeakMap<object, MvEmitCache>()

/** The emit cache for one registered MV, created on first use. */
export function emitCacheFor(reg: object): MvEmitCache {
  let c = caches.get(reg)
  if (c === undefined) { c = new MvEmitCache(); caches.set(reg, c) }
  return c
}
