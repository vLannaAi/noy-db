/**
 * #1410 — a value that carries NO timezone is a civil (calendar) date, and its
 * bucket must not depend on `timeZone` at all.
 *
 * Reported by a downstream consumer against the shipped `0.7.1-pre.0.6` dist:
 * `'2026-01-01'` bucketed to `2025-12` for `America/New_York`, silently, with
 * no error — a wrong statutory period. The cause is a category error, not an
 * off-by-one: `Date.parse('2026-01-01')` resolves a date-only string to UTC
 * midnight per ECMA-262, and converting that instant into a west-of-UTC zone
 * moves it back a day.
 *
 * The property under test is stated once and asserted across the matrix:
 * **for a zoneless value, the bucket is the same in every zone**, including at
 * a year and a quarter boundary. The converse half matters just as much and is
 * asserted below it: a value that IS an instant (a `Date`, epoch millis, or a
 * string carrying `Z` / an offset) must still convert, and must still bucket
 * differently in different zones near a day boundary.
 */
import { describe, it, expect } from 'vitest'
import { dateTrunc, truncateDate, describeGroupKey } from '../src/kernel/query/reduce/date-trunc.js'
// #1458 — the query DSL ships in four groups; these side-effect imports
// attach the extension methods this file exercises. A consumer on the root
// barrel needs none of them (it imports all three); this file builds its
// Query from `kernel/query` directly, so it takes what it uses.
import '../src/kernel/query/reduce/index.js'

/** −10 through +14, so any zone-dependence shows up as a wrong bucket. */
const ZONES = [
  'Pacific/Honolulu', // −10
  'America/New_York', // −05 / −04
  'UTC',
  'Asia/Bangkok', // +07
  'Pacific/Kiritimati', // +14
] as const

type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year'

/** civil input → the bucket it must produce, in EVERY zone. */
const CASES: ReadonlyArray<readonly [string, Record<Unit, string>]> = [
  // The sharp edge from the report: January must never land in the prior year.
  ['2026-01-01', {
    day: '2026-01-01', week: '2025-12-29', month: '2026-01-01',
    quarter: '2026-01-01', year: '2026-01-01',
  }],
  // Quarter boundaries, each the first day of its quarter.
  ['2026-04-01', {
    day: '2026-04-01', week: '2026-03-30', month: '2026-04-01',
    quarter: '2026-04-01', year: '2026-01-01',
  }],
  ['2026-07-01', {
    day: '2026-07-01', week: '2026-06-29', month: '2026-07-01',
    quarter: '2026-07-01', year: '2026-01-01',
  }],
  ['2026-10-01', {
    day: '2026-10-01', week: '2026-09-28', month: '2026-10-01',
    quarter: '2026-10-01', year: '2026-01-01',
  }],
  // The other side of the year boundary — must never land in 2027.
  ['2026-12-31', {
    day: '2026-12-31', week: '2026-12-28', month: '2026-12-01',
    quarter: '2026-10-01', year: '2026-01-01',
  }],
]

const UNITS: readonly Unit[] = ['day', 'week', 'month', 'quarter', 'year']

describe('dateTrunc > a date-only value is civil: the bucket does not depend on timeZone (#1410)', () => {
  for (const [input, expected] of CASES) {
    for (const unit of UNITS) {
      it(`${input} → ${unit} → ${expected[unit]} in every zone`, () => {
        for (const timeZone of ZONES) {
          const key = dateTrunc('d', unit, { timeZone })
          expect(`${timeZone}: ${String(truncateDate(input, key))}`).toBe(
            `${timeZone}: ${expected[unit]}`,
          )
        }
      })
    }
  }

  it('is stable under weekStartsOn: sunday too', () => {
    for (const timeZone of ZONES) {
      const key = dateTrunc('d', 'week', { timeZone, weekStartsOn: 'sunday' })
      // 2026-01-01 is a Thursday; the sunday-start week began 2025-12-28.
      expect(truncateDate('2026-01-01', key)).toBe('2025-12-28')
    }
  })

  it('accepts the shorter ISO calendar forms, which are civil for the same reason', () => {
    for (const timeZone of ZONES) {
      expect(truncateDate('2026-01', dateTrunc('d', 'month', { timeZone }))).toBe('2026-01-01')
      expect(truncateDate('2026', dateTrunc('d', 'year', { timeZone }))).toBe('2026-01-01')
      expect(truncateDate('2026-1-1', dateTrunc('d', 'month', { timeZone }))).toBe('2026-01-01')
    }
  })

  it('treats an OFFSETLESS date-time as civil — it names no instant either', () => {
    // ECMA-262 parses this as HOST-local, which is the same class of defect one
    // layer down: the bucket would depend on the machine the query ran on.
    for (const timeZone of ZONES) {
      const key = dateTrunc('d', 'month', { timeZone })
      expect(truncateDate('2026-01-01T00:00:00', key)).toBe('2026-01-01')
      expect(truncateDate('2026-01-01T23:59:59.999', key)).toBe('2026-01-01')
      expect(truncateDate('2026-01-01 08:30', key)).toBe('2026-01-01')
    }
  })
})

describe('dateTrunc > an INSTANT still converts through the zone (#1410 must not break this)', () => {
  const NEAR_MIDNIGHT_UTC = '2026-01-01T00:30:00Z'

  it('a Z-suffixed string is an instant, so its bucket IS zone-dependent', () => {
    const day = (tz: string) => truncateDate(NEAR_MIDNIGHT_UTC, dateTrunc('d', 'day', { timeZone: tz }))
    expect(day('UTC')).toBe('2026-01-01')
    expect(day('Asia/Bangkok')).toBe('2026-01-01') // 07:30 local
    expect(day('America/New_York')).toBe('2025-12-31') // 19:30 previous day
    expect(day('Pacific/Honolulu')).toBe('2025-12-31') // 14:30 previous day
    expect(day('Pacific/Kiritimati')).toBe('2026-01-01') // 14:30 same day
  })

  it('an explicit offset is an instant too', () => {
    // 2026-01-01T00:30+07:00 === 2025-12-31T17:30Z
    const key = dateTrunc('d', 'month', { timeZone: 'UTC' })
    expect(truncateDate('2026-01-01T00:30:00+07:00', key)).toBe('2025-12-01')
  })

  it('a Date object is an instant', () => {
    const value = new Date(NEAR_MIDNIGHT_UTC)
    expect(truncateDate(value, dateTrunc('d', 'day', { timeZone: 'UTC' }))).toBe('2026-01-01')
    expect(truncateDate(value, dateTrunc('d', 'day', { timeZone: 'America/New_York' }))).toBe('2025-12-31')
  })

  it('epoch milliseconds are an instant', () => {
    const ms = Date.parse(NEAR_MIDNIGHT_UTC)
    expect(truncateDate(ms, dateTrunc('d', 'year', { timeZone: 'UTC' }))).toBe('2026-01-01')
    expect(truncateDate(ms, dateTrunc('d', 'year', { timeZone: 'Pacific/Honolulu' }))).toBe('2025-01-01')
  })

  it('still refuses a non-timestamp, and an impossible calendar date', () => {
    const key = dateTrunc('d', 'month', { timeZone: 'UTC' })
    expect(() => truncateDate('not a date', key)).toThrow(/not a timestamp/)
    // V8's Date.parse rolls '2026-02-30' over to 2 March; a typo must not be
    // bucketed under a wrong-but-plausible key, so a calendar shape naming no
    // real day is refused (#1410).
    expect(() => truncateDate('2026-02-30', key)).toThrow(/names no real day/)
    expect(() => truncateDate('2026-13-01', key)).toThrow(/names no real day/)
    expect(() => truncateDate('2025-02-29', key)).toThrow(/names no real day/)
    expect(truncateDate('2024-02-29', key)).toBe('2024-02-01') // a real leap day
  })
})

describe('dateTrunc > the key identity is unchanged by #1410', () => {
  it('describeGroupKey still emits exactly the five pre-#1410 parameters', () => {
    // The fix adds no field to DateTruncKey, so every stored MV queryHash is
    // byte-identical to its pre-fix value. See the PR release note.
    expect(describeGroupKey(dateTrunc('issuedAt', 'month', { timeZone: 'Asia/Bangkok' }))).toBe(
      'dateTrunc(issuedAt|month|Asia/Bangkok|monday|issuedAt_month)',
    )
  })
})
