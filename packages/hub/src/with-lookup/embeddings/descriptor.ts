/** Per-collection embedding config (L2). The encode hook is host/remote — no bundled model. */
import { getAtPath } from '../../via/i18n/core.js'
import type { EmbeddingChunkSpan } from './chunks.js'

export interface EmbeddingDescriptor {
  readonly source: string | readonly string[]
  readonly encode: (text: string) => Promise<Float32Array>
  readonly dim: number
  readonly model: string
  /**
   * Optional sub-document splitter (#1360). Given the record's joined source
   * text (`embeddingSourceText(record, source)`), return the spans to encode
   * separately — `start`/`end` are character offsets into THAT string. When
   * declared and non-empty, the record is scored by its BEST chunk and the
   * winning span comes back on the hit; when absent or empty, the record keeps
   * exactly one whole-text vector, as before.
   */
  readonly chunk?: (text: string) => readonly EmbeddingChunkSpan[]
}

/** Concatenate the record's source-field text (skips empties; supports nested/[]-wildcard paths). */
export function embeddingSourceText(record: Record<string, unknown>, source: string | readonly string[]): string {
  const fields = typeof source === 'string' ? [source] : source
  const parts: string[] = []
  for (const f of fields) {
    for (const leaf of getAtPath(record, f)) {
      if (typeof leaf === 'string' && leaf !== '') parts.push(leaf)
    }
  }
  return parts.join(' ')
}
