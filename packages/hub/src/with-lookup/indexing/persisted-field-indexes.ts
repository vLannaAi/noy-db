/**
 * Persisted encrypted field indexes (#1359) — the debounce + freshness half.
 *
 * Shape deliberately mirrors the search index's `PersistedIndexStore`: this
 * class is CRYPTO-FREE and storage-free. The collection injects
 * load/save/remove callbacks that encrypt under the collection's DEK before
 * they touch the adapter, so an index sidecar is ciphertext at rest like every
 * other byte hub writes — the trust boundary does not move.
 *
 * One sidecar per `(collection, index)`, addressed by the index's sidecar key
 * (`s:<field>` / `c:<f1>,<f2>`).
 *
 * ## Why crash residue can only ever be a rebuild
 *
 * A sidecar is a CACHE of something the record cache can always recompute, and
 * it is used only when four independent checks pass:
 *
 *  1. it decrypts under the collection's DEK (a foreign or corrupt blob does not),
 *  2. it parses as the CURRENT snapshot format, entries well-formed and in the
 *     order the binary searches assume (`parseFieldIndexSnapshot`),
 *  3. its freshness stamp equals the live one — record count, max record
 *     version, and an order-independent digest over every `(id, version)` pair
 *     in the cache, so any write, delete or re-put since the sidecar was
 *     written changes it,
 *  4. every id it names is still live in the cache.
 *
 * Any failure discards the whole blob and rebuilds from the cache. There is no
 * repair path and no partial load, by construction: a half-adopted index would
 * answer confidently and wrongly, which is the one outcome persistence may not
 * introduce. A save that never lands, lands torn, or lands and is then
 * overtaken by a crashed write leaves at most a blob that fails check 2, 3 or 4.
 *
 * The residual is a blob at rest holding indexed field VALUES after a
 * `forget()` — closed by `purgePersistedIndexes`, which deletes these sidecars
 * on erasure the same way it deletes the lazy-mode ones.
 */
import type { FieldIndexSnapshot } from './index-snapshot.js'
import { parseFieldIndexSnapshot } from './index-snapshot.js'

/**
 * The freshness stamp. `count` + `maxVersion` is the search store's signal;
 * `digest` is the strengthening this index needs — an ordered index is wrong
 * in a way a search index is merely imprecise, so a stamp that two different
 * cache states can share is not good enough. See {@link fieldIndexFingerprint}.
 */
export interface FieldIndexFingerprint {
  readonly count: number
  readonly maxVersion: number
  readonly digest: string
}

export interface FieldIndexCallbacks {
  /** Sidecar keys to persist, and the snapshot/restore hooks over them. */
  keys(): readonly string[]
  snapshot(key: string): FieldIndexSnapshot | undefined
  restore(key: string, snap: FieldIndexSnapshot, isLive: (id: string) => boolean): boolean
  load(key: string): Promise<{ json: string; fingerprint: FieldIndexFingerprint } | null>
  save(key: string, json: string, fp: FieldIndexFingerprint): Promise<void>
  remove(key: string): Promise<void>
  currentFingerprint(): FieldIndexFingerprint
  debounceMs?: number
}

/**
 * An order-independent stamp over the cache's `(id, version)` pairs.
 *
 * Order-independent because cache iteration order is the adapter's `list()`
 * order and is not promised to be stable across opens; a stamp that changed
 * with it would reject every fresh sidecar and quietly turn persistence off.
 * Two 32-bit accumulators (sum and xor over FNV-1a) rather than one, so a
 * collision needs both to agree. `_v` increments on every write, so a changed
 * record body always changes this — a record's indexed values cannot move
 * underneath a matching stamp.
 */
export function fieldIndexFingerprint(
  cache: ReadonlyMap<string, { readonly version: number }>,
): FieldIndexFingerprint {
  let sum = 0
  let xor = 0
  let maxVersion = 0
  for (const [id, entry] of cache) {
    const h = fnv1a(`${id} ${entry.version}`)
    sum = (sum + h) >>> 0
    xor = (xor ^ h) >>> 0
    if (entry.version > maxVersion) maxVersion = entry.version
  }
  return { count: cache.size, maxVersion, digest: `${sum.toString(36)}.${xor.toString(36)}` }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function fpEqual(a: FieldIndexFingerprint, b: FieldIndexFingerprint): boolean {
  return a.count === b.count && a.maxVersion === b.maxVersion && a.digest === b.digest
}

/** Coordinates the sidecars of one collection's opted-in field indexes. */
export class PersistedFieldIndexes {
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly debounceMs: number

  constructor(private readonly cb: FieldIndexCallbacks) {
    this.debounceMs = cb.debounceMs ?? 1000
  }

  /** True when at least one index on this collection asked to be persisted. */
  get enabled(): boolean {
    return this.cb.keys().length > 0
  }

  /**
   * Restore whatever is fresh. Returns the sidecar keys that were adopted —
   * the caller rebuilds every other declared index from the cache. Never
   * throws for a bad blob: an unreadable sidecar is indistinguishable from an
   * absent one, and both mean "rebuild".
   */
  async restore(isLive: (id: string) => boolean): Promise<ReadonlySet<string>> {
    const keys = this.cb.keys()
    if (keys.length === 0) return EMPTY
    const live = this.cb.currentFingerprint()
    const restored = new Set<string>()
    for (const key of keys) {
      let loaded: { json: string; fingerprint: FieldIndexFingerprint } | null = null
      try {
        loaded = await this.cb.load(key)
      } catch {
        continue // an unreadable sidecar is an absent sidecar
      }
      if (loaded === null || !fpEqual(loaded.fingerprint, live)) continue
      const snap = parseFieldIndexSnapshot(loaded.json)
      if (snap === null) continue
      if (this.cb.restore(key, snap, isLive)) restored.add(key)
    }
    return restored
  }

  /** Schedule a debounced write of every opted-in sidecar. */
  markDirty(): void {
    if (this.cb.keys().length === 0) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      // Best-effort, exactly as the search store's flush is: a failed write
      // leaves a stale or absent blob, and the freshness stamp forces a
      // rebuild on the next open. It can never produce a wrong answer.
      void this.persist().catch(() => { /* stamp backstop forces a rebuild */ })
    }, this.debounceMs)
  }

  /** Force an immediate write (cancels any pending debounce). */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    await this.persist()
  }

  /** Delete every sidecar — erasure, and any point the blobs must not survive. */
  async removeAll(): Promise<{ purged: number; residue: string[] }> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    let purged = 0
    const residue: string[] = []
    for (const key of this.cb.keys()) {
      try {
        await this.cb.remove(key)
        purged++
      } catch {
        residue.push(key)
      }
    }
    return { purged, residue }
  }

  /** Drop a pending debounce without writing (collection teardown). */
  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  private async persist(): Promise<void> {
    const fp = this.cb.currentFingerprint()
    for (const key of this.cb.keys()) {
      const snap = this.cb.snapshot(key)
      if (!snap) continue
      await this.cb.save(key, JSON.stringify(snap), fp)
    }
  }
}

const EMPTY: ReadonlySet<string> = new Set()
