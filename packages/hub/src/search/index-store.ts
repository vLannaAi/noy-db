/**
 * The index persistence seam (#308 L1). MemoryIndexStore is session-scoped and
 * lazy; an opaque-blob backend (L1.5) implements the same interface so the
 * collection call-site is unchanged.
 */
import { InvertedIndex, type IndexDoc } from './inverted-index.js'

export interface IndexStore {
  getOrBuild(build: () => ReadonlyArray<IndexDoc>): InvertedIndex
  markDirty(): void
  readonly built: boolean
}

export class MemoryIndexStore implements IndexStore {
  private index: InvertedIndex | undefined

  get built(): boolean { return this.index !== undefined }

  getOrBuild(build: () => ReadonlyArray<IndexDoc>): InvertedIndex {
    if (this.index === undefined) this.index = InvertedIndex.build(build())
    return this.index
  }

  markDirty(): void { this.index = undefined }
}
