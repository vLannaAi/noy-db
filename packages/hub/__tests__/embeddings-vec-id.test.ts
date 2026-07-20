/**
 * `_vec` side-car id encode/decode (#726) — collection-namespaced keys.
 */
import { describe, it, expect } from 'vitest'
import { encodeVecId, decodeVecId, isVecIdFor } from '../src/with-lookup/embeddings/vec-id.js'

describe('encodeVecId / decodeVecId', () => {
  it('round-trips collection + recordId', () => {
    const id = encodeVecId('docs', 'doc-1')
    expect(id).toBe('docs/doc-1')
    expect(decodeVecId('docs', id)).toBe('doc-1')
  })

  it('decodes record ids that contain slashes (strips known prefix, does not split)', () => {
    const id = encodeVecId('docs', 'nested/id/with/slashes')
    expect(id).toBe('docs/nested/id/with/slashes')
    expect(decodeVecId('docs', id)).toBe('nested/id/with/slashes')
  })

  it('returns null when the id does not belong to the given collection', () => {
    const id = encodeVecId('docs', 'x')
    expect(decodeVecId('other', id)).toBeNull()
  })

  it('does not falsely match a collection whose name is a prefix of another', () => {
    // collection 'a' vs 'ab': 'a/foo' must not decode under 'ab', and
    // 'ab/foo' must not decode under 'a'.
    expect(decodeVecId('ab', encodeVecId('a', 'foo'))).toBeNull()
    expect(decodeVecId('a', encodeVecId('ab', 'foo'))).toBeNull()
  })
})

describe('encodeVecId rejects ambiguous collection names', () => {
  it('throws when the collection name contains "/" (would make isVecIdFor\'s prefix match ambiguous)', () => {
    expect(() => encodeVecId('a/b', 'x')).toThrow()
  })
})

describe('isVecIdFor', () => {
  it('is true for ids belonging to the collection', () => {
    expect(isVecIdFor('docs', 'docs/x')).toBe(true)
    expect(isVecIdFor('docs', 'docs/nested/id/with/slashes')).toBe(true)
  })

  it('is false for ids belonging to a different collection', () => {
    expect(isVecIdFor('docs', 'other/x')).toBe(false)
    expect(isVecIdFor('ab', 'a/foo')).toBe(false)
    expect(isVecIdFor('a', 'ab/foo')).toBe(false)
  })
})
