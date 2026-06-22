import { describe, it, expect } from 'vitest'
import { cosine } from '../src/embeddings/cosine.js'

describe('cosine (#308 L2)', () => {
  it('identical vectors → 1', () => { expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6) })
  it('orthogonal → 0', () => { expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6) })
  it('opposite → -1', () => { expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 6) })
  it('zero-norm → 0 (no NaN)', () => { expect(cosine([0, 0], [1, 1])).toBe(0) })
  it('length mismatch → 0', () => { expect(cosine([1, 2], [1, 2, 3])).toBe(0) })
})
