/** (De)serialize an InvertedIndex to/from a JSON string for persistence (L1.5). */
import { InvertedIndex } from './inverted-index.js'

export function serializeIndex(idx: InvertedIndex): string {
  return JSON.stringify(idx.toSnapshot())
}

export function deserializeIndex(json: string): InvertedIndex {
  return InvertedIndex.fromSnapshot(JSON.parse(json))
}
