/**
 * The index persistence seam (L1.5). MemoryIndexStore is session-scoped and
 * lazy; an opaque-blob backend implements the same interface so the
 * collection call-site is unchanged.
 */
import { InvertedIndex, type IndexDoc, type IndexBuildOptions } from './inverted-index.js'

export interface IndexStore {
  /** `opts` carries the positional-postings opt-in (#1354); a persisted store also
   *  uses it to decide whether a loaded sidecar still matches the live config. */
  ensureBuilt(build: () => ReadonlyArray<IndexDoc>, opts?: IndexBuildOptions): Promise<InvertedIndex>
  markDirty(): void
  flush(): Promise<void>
  readonly built: boolean
}

export class MemoryIndexStore implements IndexStore {
  private index: InvertedIndex | undefined

  get built(): boolean { return this.index !== undefined }

  async ensureBuilt(build: () => ReadonlyArray<IndexDoc>, opts?: IndexBuildOptions): Promise<InvertedIndex> {
    if (this.index === undefined) this.index = InvertedIndex.build(build(), opts)
    return this.index
  }

  markDirty(): void { this.index = undefined }

  async flush(): Promise<void> { /* in-memory: nothing to persist */ }
}
