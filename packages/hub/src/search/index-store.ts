/**
 * The index persistence seam (#308 L1.5). MemoryIndexStore is session-scoped and
 * lazy; an opaque-blob backend implements the same interface so the
 * collection call-site is unchanged.
 */
import { InvertedIndex, type IndexDoc } from './inverted-index.js'

export interface IndexStore {
  ensureBuilt(build: () => ReadonlyArray<IndexDoc>): Promise<InvertedIndex>
  markDirty(): void
  flush(): Promise<void>
  readonly built: boolean
}

export class MemoryIndexStore implements IndexStore {
  private index: InvertedIndex | undefined

  get built(): boolean { return this.index !== undefined }

  async ensureBuilt(build: () => ReadonlyArray<IndexDoc>): Promise<InvertedIndex> {
    if (this.index === undefined) this.index = InvertedIndex.build(build())
    return this.index
  }

  markDirty(): void { this.index = undefined }

  async flush(): Promise<void> { /* in-memory: nothing to persist */ }
}
