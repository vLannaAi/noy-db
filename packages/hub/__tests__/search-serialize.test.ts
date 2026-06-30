import { describe, it, expect } from 'vitest'
import { InvertedIndex, type IndexDoc } from '../src/with-lookup/search/inverted-index.js'
import { serializeIndex, deserializeIndex } from '../src/with-lookup/search/serialize.js'

const docs: IndexDoc[] = [
  { id: 'a', fields: [{ field: 'desc', text: 'overdue invoice TCM' }] },
  { id: 'b', fields: [{ field: 'desc', text: 'paid invoice' }, { field: 'notes', locale: 'th', text: 'ค่าเช่า TCM' }] },
]

describe('index snapshot round-trip (#308 L1.5)', () => {
  it('serialize → deserialize yields identical query results', () => {
    const orig = InvertedIndex.build(docs)
    const restored = deserializeIndex(serializeIndex(orig))
    for (const q of ['invoice', 'TCM', 'ค่าเช่า', 'paid']) {
      expect(restored.query(q)).toEqual(orig.query(q))
    }
  })
  it('preserves locale + offsets (snippet fidelity)', () => {
    const restored = deserializeIndex(serializeIndex(InvertedIndex.build(docs)))
    const hit = restored.query('ค่าเช่า').find((h) => h.id === 'b')!
    expect(hit.locale).toBe('th')
    expect(hit.text.slice(hit.offset, hit.offset + 'ค่าเช่า'.length)).toBe('ค่าเช่า')
  })
})
