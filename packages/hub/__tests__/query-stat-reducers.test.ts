/**
 * Statistical reducers — `median`, `percentile`, `stddev`, `variance`, `mode`
 * (#1353).
 *
 * The contract these tests pin down, because every one of them is a place a
 * "present but unusable" implementation silently disagrees with its user:
 *
 *   - percentile definition is **`percentile_cont`** (interpolating), and
 *     `median` is exactly `percentile(f, 0.5)`.
 *   - `mode` breaks a frequency tie by taking the **lowest value**.
 *   - `variance` / `stddev` are **sample** (n−1) by default, `{ population: true }`
 *     for the n divisor — the Postgres `var_samp` / `var_pop` split.
 *   - `variance` / `stddev` are streaming **Welford**, so an accounting-shaped
 *     column (large mean, small spread) does not lose every significant digit.
 */

import { describe, it, expect } from 'vitest'
import {
  median,
  percentile,
  stddev,
  variance,
  mode,
  reduceRecords,
  applyWindow,
} from '../src/with-lookup/reduce/index.js'

const rows = (values: readonly number[]): { amount: number }[] => values.map((amount) => ({ amount }))

const runOne = <R,>(values: readonly number[], reducer: { init(): unknown; step(s: unknown, r: unknown): unknown; finalize(s: unknown): unknown }): R =>
  reduceRecords(rows(values), { out: reducer as never }).out as R

// ---------------------------------------------------------------------------
// variance / stddev — Welford, sample by default
// ---------------------------------------------------------------------------

describe('variance / stddev', () => {
  const SAMPLE = [2, 4, 4, 4, 5, 5, 7, 9]

  it('defaults to the SAMPLE (n−1) divisor', () => {
    expect(runOne<number>(SAMPLE, variance('amount'))).toBeCloseTo(4.571428571428571, 12)
    expect(runOne<number>(SAMPLE, stddev('amount'))).toBeCloseTo(2.138089935299395, 12)
  })

  it('{ population: true } uses the n divisor', () => {
    expect(runOne<number>(SAMPLE, variance('amount', { population: true }))).toBeCloseTo(4, 12)
    expect(runOne<number>(SAMPLE, stddev('amount', { population: true }))).toBeCloseTo(2, 12)
  })

  /**
   * The reason Welford is not an implementation detail.
   *
   * Four invoice totals a hair over one billion. The textbook one-pass formula
   * (Σx² − (Σx)²/n) / (n−1) returns **−170.66666666666666** here, and its
   * population twin returns **−128** — a NEGATIVE variance, so `stddev` is NaN.
   * Every x² is ~1e18, past 2^53, so the subtraction cancels away more bits
   * than the answer has. Welford returns the exact 30.
   */
  it('survives a large-mean / small-variance accounting column (naive formula returns a NEGATIVE variance)', () => {
    const invoices = [1_000_000_004, 1_000_000_007, 1_000_000_013, 1_000_000_016]
    expect(runOne<number>(invoices, variance('amount'))).toBeCloseTo(30, 9)
    expect(runOne<number>(invoices, variance('amount', { population: true }))).toBeCloseTo(22.5, 9)
    expect(runOne<number>(invoices, stddev('amount'))).toBeCloseTo(Math.sqrt(30), 9)
  })

  it('empty input is null; a single element is null for sample and 0 for population', () => {
    expect(runOne<number | null>([], variance('amount'))).toBeNull()
    expect(runOne<number | null>([], stddev('amount'))).toBeNull()
    expect(runOne<number | null>([], variance('amount', { population: true }))).toBeNull()
    expect(runOne<number | null>([42], variance('amount'))).toBeNull()
    expect(runOne<number | null>([42], stddev('amount'))).toBeNull()
    expect(runOne<number | null>([42], variance('amount', { population: true }))).toBe(0)
    expect(runOne<number | null>([42], stddev('amount', { population: true }))).toBe(0)
  })

  it('remove() un-folds a record (reverse Welford)', () => {
    const r = variance('amount')
    let s = r.init()
    for (const v of [...SAMPLE, 999]) s = r.step(s, { amount: v })
    s = r.remove!(s, { amount: 999 })
    expect(r.finalize(s)).toBeCloseTo(4.571428571428571, 9)
  })

  it('merge() of two partial states equals the whole', () => {
    const r = variance('amount')
    const fold = (vs: readonly number[]) => vs.reduce((s, v) => r.step(s, { amount: v }), r.init())
    const merged = r.merge!(fold(SAMPLE.slice(0, 3)), fold(SAMPLE.slice(3)))
    expect(r.finalize(merged)).toBeCloseTo(4.571428571428571, 12)
  })
})

// ---------------------------------------------------------------------------
// median / percentile — percentile_cont
// ---------------------------------------------------------------------------

describe('median / percentile (percentile_cont)', () => {
  it('median of an ODD count is the middle value', () => {
    expect(runOne<number>([3, 1, 2], median('amount'))).toBe(2)
  })

  /** The case where `percentile_cont` and `percentile_disc` disagree. */
  it('median of an EVEN count INTERPOLATES (2.5), it does not pick a member (2 or 3)', () => {
    const m = runOne<number>([4, 1, 3, 2], median('amount'))
    expect(m).toBe(2.5)
    expect(m).not.toBe(2)
    expect(m).not.toBe(3)
  })

  it('percentile(0.5) is median, and p=0.9 interpolates between members', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(runOne<number>(values, percentile('amount', 0.5))).toBe(5.5)
    // x = 0.9 * (10-1) = 8.1 → v[8] + 0.1*(v[9]-v[8]) = 9.1. `_disc` would say 9.
    expect(runOne<number>(values, percentile('amount', 0.9))).toBeCloseTo(9.1, 12)
  })

  it('p=0 is the minimum and p=1 is the maximum', () => {
    const values = [5, 1, 9, 3]
    expect(runOne<number>(values, percentile('amount', 0))).toBe(1)
    expect(runOne<number>(values, percentile('amount', 1))).toBe(9)
  })

  it('rejects a p outside [0, 1]', () => {
    expect(() => percentile('amount', 1.5)).toThrow(/between 0 and 1/)
    expect(() => percentile('amount', -0.1)).toThrow(/between 0 and 1/)
    expect(() => percentile('amount', Number.NaN)).toThrow(/between 0 and 1/)
  })

  it('empty is null; a single element is that element at every p', () => {
    expect(runOne<number | null>([], median('amount'))).toBeNull()
    expect(runOne<number | null>([], percentile('amount', 0.9))).toBeNull()
    expect(runOne<number | null>([7], median('amount'))).toBe(7)
    expect(runOne<number | null>([7], percentile('amount', 0))).toBe(7)
    expect(runOne<number | null>([7], percentile('amount', 1))).toBe(7)
  })

  it('remove() drops one instance from the multiset', () => {
    const r = median('amount')
    let s = r.init()
    for (const v of [1, 2, 3, 4, 100]) s = r.step(s, { amount: v })
    s = r.remove!(s, { amount: 100 })
    expect(r.finalize(s)).toBe(2.5)
  })
})

// ---------------------------------------------------------------------------
// percentile({ approx: true }) — t-digest
// ---------------------------------------------------------------------------

describe('percentile({ approx: true })', () => {
  const N = 10_000
  const values = Array.from({ length: N }, (_, i) => i)

  /**
   * A uniform ramp is NOT a test of a t-digest — every centroid mean lands on
   * the line, so a broken digest still interpolates the right answer. The
   * fixture is a deterministic heavy-tailed (exponential) draw, which is what
   * actually exercises the variable centroid budget.
   */
  const skewed = ((): number[] => {
    let seed = 42
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    return Array.from({ length: N }, () => Math.round(Math.exp(rnd() * 9) * 100) / 100)
  })()

  it('tracks the exact percentile within 1% RELATIVE error on a heavy-tailed 10k scan', () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      const exact = runOne<number>(skewed, percentile('amount', p))
      const approx = runOne<number>(skewed, percentile('amount', p, { approx: true }))
      expect(Math.abs(approx - exact) / exact).toBeLessThan(0.01)
    }
  })

  it('is exact at the extremes of the heavy-tailed fixture too', () => {
    const sorted = [...skewed].sort((a, b) => a - b)
    expect(runOne<number>(skewed, percentile('amount', 0, { approx: true }))).toBe(sorted[0])
    expect(runOne<number>(skewed, percentile('amount', 1, { approx: true }))).toBe(sorted[N - 1])
  })

  it('is exact at the extremes', () => {
    expect(runOne<number>(values, percentile('amount', 0, { approx: true }))).toBe(0)
    expect(runOne<number>(values, percentile('amount', 1, { approx: true }))).toBe(N - 1)
  })

  it('keeps far fewer than n values in state', () => {
    const r = percentile('amount', 0.5, { approx: true })
    let s = r.init()
    for (const v of values) s = r.step(s, { amount: v })
    r.finalize(s)
    const centroids = (s as { centroids?: readonly unknown[] }).centroids ?? []
    expect(centroids.length).toBeGreaterThan(0)
    // ~472 for n = 10,000 at compression 100 — a 20x reduction, and the point
    // is that it stops growing with n, not the exact figure.
    expect(centroids.length).toBeLessThan(N / 10)
  })

  it('offers no remove() — a t-digest cannot un-fold a value', () => {
    expect(percentile('amount', 0.5, { approx: true }).remove).toBeUndefined()
    expect(percentile('amount', 0.5).remove).toBeDefined()
  })

  it('empty is null', () => {
    expect(runOne<number | null>([], percentile('amount', 0.5, { approx: true }))).toBeNull()
  })

  it('merge() combines two digests', () => {
    const r = percentile('amount', 0.5, { approx: true })
    const fold = (vs: readonly number[]) => vs.reduce((s, v) => r.step(s, { amount: v }), r.init())
    const merged = r.merge!(fold(values.slice(0, 5000)), fold(values.slice(5000)))
    expect(Math.abs((r.finalize(merged) as number) - 4999.5)).toBeLessThan(N * 0.01)
  })
})

// ---------------------------------------------------------------------------
// mode
// ---------------------------------------------------------------------------

describe('mode', () => {
  it('is the most frequent value', () => {
    expect(runOne<number>([1, 2, 2, 3], mode('amount'))).toBe(2)
  })

  it('breaks a frequency tie by taking the LOWEST value, whatever the input order', () => {
    expect(runOne<number>([1, 1, 2, 2], mode('amount'))).toBe(1)
    expect(runOne<number>([2, 2, 1, 1], mode('amount'))).toBe(1)
    expect(runOne<number>([9, 9, 4, 4, 7, 7], mode('amount'))).toBe(4)
  })

  it('empty is null; a single element is that element', () => {
    expect(runOne<number | null>([], mode('amount'))).toBeNull()
    expect(runOne<number | null>([7], mode('amount'))).toBe(7)
  })

  it('remove() drops one occurrence, and can change the answer', () => {
    const r = mode('amount')
    let s = r.init()
    for (const v of [1, 2, 2, 3]) s = r.step(s, { amount: v })
    s = r.remove!(s, { amount: 2 })
    // now 1, 2, 3 each once → lowest wins
    expect(r.finalize(s)).toBe(1)
  })

  it('merge() is order independent', () => {
    const r = mode('amount')
    const fold = (vs: readonly number[]) => vs.reduce((s, v) => r.step(s, { amount: v }), r.init())
    expect(r.finalize(r.merge!(fold([1, 1]), fold([2, 2])))).toBe(1)
    expect(r.finalize(r.merge!(fold([2, 2]), fold([1, 1])))).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// window (#1349) — any Reducer is a running aggregate in a .select() slot
// ---------------------------------------------------------------------------

describe('in a window slot', () => {
  it('stddev runs as a streaming running statistic', () => {
    const records = rows([2, 4, 4, 4])
    const out = applyWindow<{ amount: number; sd: number | null }>(
      records,
      { orderBy: 'amount' },
      { sd: stddev('amount', { population: true }) },
    )
    expect(out.map((r) => r.sd)).toEqual([0, 1, expect.closeTo(0.9428090415820634, 12), expect.closeTo(0.8660254037844386, 12)])
  })

  it('median runs as a running median', () => {
    const out = applyWindow<{ amount: number; m: number | null }>(
      rows([1, 2, 3, 4]),
      { orderBy: 'amount' },
      { m: median('amount') },
    )
    expect(out.map((r) => r.m)).toEqual([1, 1.5, 2, 2.5])
  })
})
