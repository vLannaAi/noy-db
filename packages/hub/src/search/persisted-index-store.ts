/**
 * Persisted backend for the L1 lexical index (#308 L1.5). Crypto-free: the
 * collection injects load/save/remove + a fingerprint provider. In-memory while
 * live (L1 behavior); persists an opaque snapshot via a debounced flush, and
 * validates a loaded blob against a {count,maxVersion} fingerprint so a stale
 * blob is never used — only rebuilt.
 */
import { InvertedIndex, type IndexDoc } from './inverted-index.js'
import { serializeIndex, deserializeIndex } from './serialize.js'
import type { IndexStore } from './index-store.js'

export interface Fingerprint { readonly count: number; readonly maxVersion: number }

export interface PersistedIndexCallbacks {
  load(): Promise<{ json: string; fingerprint: Fingerprint } | null>
  save(json: string, fp: Fingerprint): Promise<void>
  remove(): Promise<void>
  currentFingerprint(): Fingerprint
  debounceMs?: number
}

function fpEqual(a: Fingerprint, b: Fingerprint): boolean {
  return a.count === b.count && a.maxVersion === b.maxVersion
}

export class PersistedIndexStore implements IndexStore {
  private index: InvertedIndex | undefined
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastBuild: (() => ReadonlyArray<IndexDoc>) | undefined
  private readonly debounceMs: number

  constructor(private readonly cb: PersistedIndexCallbacks) {
    this.debounceMs = cb.debounceMs ?? 1000
  }

  get built(): boolean { return this.index !== undefined }

  async ensureBuilt(build: () => ReadonlyArray<IndexDoc>): Promise<InvertedIndex> {
    this.lastBuild = build
    if (this.index !== undefined) return this.index
    const loaded = await this.cb.load()
    if (loaded !== null && fpEqual(loaded.fingerprint, this.cb.currentFingerprint())) {
      this.index = deserializeIndex(loaded.json)
      return this.index
    }
    this.index = InvertedIndex.build(build())
    await this.persist()
    return this.index
  }

  markDirty(): void {
    this.index = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.rebuildAndPersist().catch(() => { /* best-effort flush; fingerprint backstop forces rebuild next load */ })
    }, this.debounceMs)
  }

  /** Force an immediate persist (cancels any pending debounce). */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    await this.rebuildAndPersist()
  }

  /** Delete the persisted blob and drop the in-memory index (forget/erasure). */
  async removePersisted(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.index = undefined
    await this.cb.remove()
  }

  /** Rebuild using the last known build thunk, then persist. */
  private async rebuildAndPersist(): Promise<void> {
    if (this.lastBuild === undefined) return
    if (this.index === undefined) {
      this.index = InvertedIndex.build(this.lastBuild())
    }
    await this.persist()
  }

  private async persist(): Promise<void> {
    if (this.index === undefined) return
    await this.cb.save(serializeIndex(this.index), this.cb.currentFingerprint())
  }
}
