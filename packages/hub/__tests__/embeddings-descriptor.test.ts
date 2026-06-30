import { describe, it, expect } from 'vitest'
import { embeddingSourceText } from '../src/with-lookup/embeddings/descriptor.js'
import { EmbeddingDimMismatchError, EmbeddingModelMismatchError } from '../src/errors.js'

describe('embeddingSourceText (#308 L2)', () => {
  it('joins multiple source fields, skipping empties', () => {
    expect(embeddingSourceText({ a: 'overdue', b: '', c: 'invoice' }, ['a', 'b', 'c'])).toBe('overdue invoice')
  })
  it('single string source', () => {
    expect(embeddingSourceText({ desc: 'TCM rent' }, 'desc')).toBe('TCM rent')
  })
  it('nested/wildcard path via getAtPath', () => {
    expect(embeddingSourceText({ items: [{ d: 'a' }, { d: 'b' }] }, 'items[].d')).toBe('a b')
  })
})

describe('embedding errors (#308 L2)', () => {
  it('dim mismatch carries field/expected/actual', () => {
    const e = new EmbeddingDimMismatchError('vec', 768, 384)
    expect(e).toBeInstanceOf(Error); expect(e.message).toContain('768'); expect(e.message).toContain('384')
  })
  it('model mismatch carries the two models', () => {
    const e = new EmbeddingModelMismatchError('minilm-v2', 'minilm-v1')
    expect(e.message).toContain('minilm-v2'); expect(e.message).toContain('minilm-v1')
  })
})
