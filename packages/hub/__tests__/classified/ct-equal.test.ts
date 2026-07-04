import { describe, it, expect } from 'vitest'
import { ctEqualTags, blindedEqual } from '../../src/kernel/enclave/classify/compare.js'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('ctEqualTags (fixed 32-byte tags only)', () => {
  it('true for identical 32-byte tags, false for a single-bit difference', () => {
    const a = new Uint8Array(32).fill(0xab)
    const b = new Uint8Array(32).fill(0xab)
    expect(ctEqualTags(a, b)).toBe(true)
    b[31] = 0xaa
    expect(ctEqualTags(a, b)).toBe(false)
  })

  it('throws (caller bug) on any non-32-byte input — tag length is structural', () => {
    const ok = new Uint8Array(32)
    expect(() => ctEqualTags(new Uint8Array(31), ok)).toThrow(/32 bytes/)
    expect(() => ctEqualTags(ok, new Uint8Array(33))).toThrow(/32 bytes/)
    expect(() => ctEqualTags(new Uint8Array(0), new Uint8Array(0))).toThrow(/32 bytes/)
  })
})

describe('blindedEqual (double-HMAC reduction)', () => {
  it('equal inputs → true; unequal → false; unequal lengths → false, never a throw', async () => {
    expect(await blindedEqual(bytes('swordfish!'), bytes('swordfish!'))).toBe(true)
    expect(await blindedEqual(bytes('swordfish!'), bytes('swordfish?'))).toBe(false)
    expect(await blindedEqual(bytes('short'), bytes('a-much-longer-comparand'))).toBe(false)
  })

  it('length-invariance: wall-time does not scale with comparand length (conformance C2)', async () => {
    // HMAC cost is block-count granular (sub-µs per block); assert the 100x
    // length spread stays within a generous constant factor — a linear or
    // early-return regression blows well past it.
    //
    // Sampling is interleaved round-robin with per-class medians (#564): a
    // single contiguous window per class is at the mercy of whatever CPU-
    // contention burst lands inside it (concurrent CI suites, GC) — one such
    // burst dilated the `short` window 13x. A spike now either hits all three
    // classes of a round alike or is discarded by the median.
    const ROUNDS = 10
    const PER_ROUND = 20 // 10 × 20 = the same 200 total iterations per class
    const timeOnce = async (a: Uint8Array, b: Uint8Array) => {
      const t0 = performance.now()
      for (let i = 0; i < PER_ROUND; i++) await blindedEqual(a, b)
      return performance.now() - t0
    }
    const median = (xs: number[]) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)]!
    await timeOnce(bytes('warmup'), bytes('warmup'))
    const shorts: number[] = []
    const longs: number[] = []
    const mixeds: number[] = []
    for (let r = 0; r < ROUNDS; r++) {
      shorts.push(await timeOnce(bytes('aa'), bytes('ab')))
      longs.push(await timeOnce(bytes('x'.repeat(200)), bytes('y'.repeat(200))))
      mixeds.push(await timeOnce(bytes('aa'), bytes('x'.repeat(200))))
    }
    const short = median(shorts)
    const long = median(longs)
    const mixed = median(mixeds)
    // Bidirectional: the short/long/mixed timings must stay within a
    // generous constant factor of each other, in either direction — a
    // regression that makes any of them disproportionately slow OR
    // disproportionately fast (e.g. an early-return short-circuit) trips this.
    expect(long).toBeLessThan(short * 5 + 50)
    expect(mixed).toBeLessThan(short * 5 + 50)
    expect(short).toBeLessThan(long * 5 + 50)
    expect(short).toBeLessThan(mixed * 5 + 50)
  })
})
