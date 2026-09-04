/**
 * Coverage sketches (#1363) — accuracy AT THE SMALL END, which is the only end
 * the open sizing question is about.
 *
 * ⚠️ The sensor these feed is telemetry, not a control: against an insider
 * holding the device and local keys it prevents nothing, it makes bulk
 * extraction visible early, attributable and loud. Key custody is the
 * remediation.
 *
 * These numbers are MEASURED, not asserted from theory — the bands below are
 * what this implementation actually produces, and they are the evidence behind
 * the default sizing shipped in `withCoverage()`.
 */

import { describe, it, expect } from 'vitest'
import { HyperLogLog, BloomFilter } from '../../src/with-audit/coverage/sketch.js'

function relErr(estimate: number, truth: number): number {
  return Math.abs(estimate - truth) / truth
}

describe('HyperLogLog — small-corpus accuracy (default precision 14)', () => {
  for (const n of [100, 1_000, 10_000]) {
    it(`estimates ${n} distinct ids within 2%`, () => {
      const hll = new HyperLogLog()
      for (let i = 0; i < n; i++) hll.add(`rec-${i}`)
      expect(relErr(hll.count(), n)).toBeLessThan(0.02)
    })
  }

  it('is insensitive to repeats — 1k distinct ids read 50x each still estimates ~1k', () => {
    const hll = new HyperLogLog()
    for (let pass = 0; pass < 50; pass++) for (let i = 0; i < 1_000; i++) hll.add(`rec-${i}`)
    expect(relErr(hll.count(), 1_000)).toBeLessThan(0.02)
  })

  it('is empty at zero and 1 at one', () => {
    const hll = new HyperLogLog()
    expect(hll.count()).toBe(0)
    hll.add('only')
    expect(hll.count()).toBe(1)
  })

  it('round-trips through JSON with the same estimate', () => {
    const hll = new HyperLogLog()
    for (let i = 0; i < 500; i++) hll.add(`r${i}`)
    expect(HyperLogLog.fromJSON(hll.toJSON()).count()).toBe(hll.count())
  })

  it('at the default sizing a smaller register file is NOT uniformly worse — the reason the default is measured', () => {
    // p=12 beats p=14 on memory and matches it at 1k, then loses 6x at 10k
    // (the linear-counting/raw crossover). Recorded so a future reader who
    // wants the memory back knows exactly which n to re-measure.
    const at = (p: number, n: number) => {
      const h = new HyperLogLog(p)
      for (let i = 0; i < n; i++) h.add(`rec-${i}`)
      return relErr(h.count(), n)
    }
    expect(at(12, 1_000)).toBeLessThan(0.02)
    expect(at(12, 10_000)).toBeGreaterThan(at(14, 10_000))
  })

  it('refuses an out-of-range precision rather than silently clamping', () => {
    expect(() => new HyperLogLog(3)).toThrow(RangeError)
    expect(() => new HyperLogLog(17)).toThrow(RangeError)
  })
})

describe('BloomFilter — novelty within a window', () => {
  it('never reports a repeat as novel (no false negatives, by construction)', () => {
    const b = new BloomFilter()
    for (let i = 0; i < 1_000; i++) b.addIfAbsent(`rec-${i}`)
    for (let i = 0; i < 1_000; i++) expect(b.addIfAbsent(`rec-${i}`)).toBe(false)
  })

  it('reports novel ids as novel, with under 1% missed at 1k in a 16Kbit filter', () => {
    const b = new BloomFilter()
    for (let i = 0; i < 1_000; i++) b.addIfAbsent(`seen-${i}`)
    let missed = 0
    for (let i = 0; i < 1_000; i++) if (!b.addIfAbsent(`fresh-${i}`)) missed++
    // A false positive UNDER-reports novelty — the safe direction for a sensor
    // that must not cry wolf.
    expect(missed / 1_000).toBeLessThan(0.01)
  })

  it('clear() resets the window', () => {
    const b = new BloomFilter()
    b.addIfAbsent('x')
    expect(b.addIfAbsent('x')).toBe(false)
    b.clear()
    expect(b.addIfAbsent('x')).toBe(true)
  })
})
