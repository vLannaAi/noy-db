import { describe, it, expect } from 'vitest'
import { Lru, parseBytes } from '../src/cache/index.js'

// ─── LRU class ─────────────────────────────────────────────────────

describe('Lru — record-count budget', () => {
  it('1. throws when neither maxRecords nor maxBytes is set', () => {
    expect(() => new Lru<string, string>({})).toThrow(/must specify maxRecords/)
  })

  it('2. set then get returns the value and counts a hit', () => {
    const lru = new Lru<string, string>({ maxRecords: 10 })
    lru.set('a', 'alpha', 5)
    expect(lru.get('a')).toBe('alpha')
    expect(lru.stats().hits).toBe(1)
    expect(lru.stats().misses).toBe(0)
  })

  it('3. get on a missing key returns undefined and counts a miss', () => {
    const lru = new Lru<string, string>({ maxRecords: 10 })
    expect(lru.get('nope')).toBeUndefined()
    expect(lru.stats().misses).toBe(1)
  })

  it('4. evicts the least-recently-used entry when over maxRecords', () => {
    const lru = new Lru<string, string>({ maxRecords: 3 })
    lru.set('a', 'A', 1)
    lru.set('b', 'B', 1)
    lru.set('c', 'C', 1)
    lru.set('d', 'D', 1) // d is added; a should be evicted

    expect(lru.has('a')).toBe(false)
    expect(lru.has('b')).toBe(true)
    expect(lru.has('c')).toBe(true)
    expect(lru.has('d')).toBe(true)
    expect(lru.stats().evictions).toBe(1)
  })

  it('5. recently-used entries survive eviction (touch promotes)', () => {
    const lru = new Lru<string, string>({ maxRecords: 3 })
    lru.set('a', 'A', 1)
    lru.set('b', 'B', 1)
    lru.set('c', 'C', 1)

    // Touch a — now a is the MRU and b becomes the LRU.
    lru.get('a')

    lru.set('d', 'D', 1) // adding d should evict b (now LRU), not a

    expect(lru.has('a')).toBe(true)
    expect(lru.has('b')).toBe(false)
    expect(lru.has('c')).toBe(true)
    expect(lru.has('d')).toBe(true)
  })

  it('6. set on existing key updates without changing the size delta', () => {
    const lru = new Lru<string, string>({ maxRecords: 3 })
    lru.set('a', 'A', 1)
    lru.set('a', 'A2', 1) // update — same key, NOT a fresh insert
    expect(lru.stats().size).toBe(1)
    expect(lru.get('a')).toBe('A2')
  })

  it('7. update on existing key promotes it to MRU', () => {
    const lru = new Lru<string, string>({ maxRecords: 3 })
    lru.set('a', 'A', 1)
    lru.set('b', 'B', 1)
    lru.set('c', 'C', 1)
    lru.set('a', 'A2', 1) // re-set a — should now be the MRU

    lru.set('d', 'D', 1) // adding d should evict b (now LRU)
    expect(lru.has('a')).toBe(true)
    expect(lru.has('b')).toBe(false)
  })

  it('8. remove drops a key without affecting hit/miss stats', () => {
    const lru = new Lru<string, string>({ maxRecords: 10 })
    lru.set('a', 'A', 5)
    expect(lru.remove('a')).toBe(true)
    expect(lru.has('a')).toBe(false)
    expect(lru.stats().bytes).toBe(0)
    expect(lru.stats().hits).toBe(0)
    expect(lru.stats().misses).toBe(0)
  })

  it('9. remove on missing key returns false', () => {
    const lru = new Lru<string, string>({ maxRecords: 10 })
    expect(lru.remove('nope')).toBe(false)
  })

  it('10. clear() empties the cache and zeroes bytes (preserves stats)', () => {
    const lru = new Lru<string, string>({ maxRecords: 10 })
    lru.set('a', 'A', 5)
    lru.get('a')
    lru.clear()
    expect(lru.stats().size).toBe(0)
    expect(lru.stats().bytes).toBe(0)
    expect(lru.stats().hits).toBe(1) // stats are preserved across clear
  })

  it('11. resetStats zeroes the counters but keeps entries', () => {
    const lru = new Lru<string, string>({ maxRecords: 10 })
    lru.set('a', 'A', 5)
    lru.get('a')
    lru.get('missing')
    lru.resetStats()
    expect(lru.stats()).toMatchObject({ hits: 0, misses: 0, evictions: 0 })
    expect(lru.has('a')).toBe(true)
  })
})

describe('Lru — byte budget', () => {
  it('12. evicts when total bytes exceed maxBytes', () => {
    const lru = new Lru<string, string>({ maxBytes: 100 })
    lru.set('a', 'A', 40)
    lru.set('b', 'B', 40)
    lru.set('c', 'C', 40) // total 120 > 100, should evict a
    expect(lru.has('a')).toBe(false)
    expect(lru.stats().bytes).toBe(80)
  })

  it('13. honors BOTH maxRecords AND maxBytes (whichever hits first)', () => {
    const lru = new Lru<string, string>({ maxRecords: 5, maxBytes: 50 })
    // Add 5 entries each 20 bytes — total 100 bytes hits maxBytes first.
    for (let i = 0; i < 5; i++) lru.set(`k${i}`, 'X', 20)
    // Two entries should remain (40 bytes <= 50)
    expect(lru.stats().bytes).toBeLessThanOrEqual(50)
    expect(lru.stats().size).toBeLessThanOrEqual(5)
  })

  it('14. update path correctly subtracts old size before adding new', () => {
    const lru = new Lru<string, string>({ maxBytes: 100 })
    lru.set('a', 'A', 30)
    lru.set('a', 'A2', 50) // replace — bytes should be 50, not 80
    expect(lru.stats().bytes).toBe(50)
  })
})

// ─── parseBytes ────────────────────────────────────────────────────

describe('parseBytes', () => {
  it('15. accepts a positive number unchanged', () => {
    expect(parseBytes(1024)).toBe(1024)
  })

  it('16. accepts a digit-only string', () => {
    expect(parseBytes('2048')).toBe(2048)
  })

  it('17. parses KB / MB / GB suffixes (case-insensitive)', () => {
    expect(parseBytes('1KB')).toBe(1024)
    expect(parseBytes('50mb')).toBe(50 * 1024 * 1024)
    expect(parseBytes('1GB')).toBe(1024 * 1024 * 1024)
  })

  it('18. accepts decimal values', () => {
    expect(parseBytes('1.5KB')).toBe(1536)
  })

  it('19. throws on empty string', () => {
    expect(() => parseBytes('')).toThrow(/empty string/)
  })

  it('20. throws on garbage input', () => {
    expect(() => parseBytes('lots')).toThrow(/invalid byte budget/)
  })

  it('21. throws on unknown unit', () => {
    expect(() => parseBytes('5TB')).toThrow(/unknown unit/)
  })

  it('22. throws on zero or negative', () => {
    expect(() => parseBytes(0)).toThrow(/positive/)
    expect(() => parseBytes(-1)).toThrow(/positive/)
  })
})
