/** Per-collection embedding config (L2). The encode hook is host/remote — no bundled model. */
import { getAtPath } from '../../shape/via-i18n/core.js'

export interface EmbeddingDescriptor {
  readonly source: string | readonly string[]
  readonly encode: (text: string) => Promise<Float32Array>
  readonly dim: number
  readonly model: string
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
