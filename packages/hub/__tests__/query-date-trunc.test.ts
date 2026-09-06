/**
 * Calendar-bucketing unit tests for `dateTrunc()` (#1350).
 *
 * The cases that actually decide correctness: DST-shortened and
 * DST-lengthened local days, week-start convention, quarter and year
 * boundaries, an instant exactly on a bucket boundary, and the same
 * instant landing in different buckets in two zones.
 */
import { describe, it, expect } from 'vitest'
import {
  dateTrunc,
  isDateTruncKey,
  truncateDate,
  describeGroupKey,
  groupKeyName,
  groupKeySourceField,
  projectDateTruncKeys,
} from '../src/kernel/query/reduce/date-trunc.js'

const at = (iso: string): Date => new Date(iso)

describe('dateTrunc > descriptor', () => {
  it('requires an explicit timeZone and defaults the week start to monday', () => {
    const k = dateTrunc('date', 'week', { timeZone: 'UTC' })
    expect(isDateTruncKey(k)).toBe(true)
    expect(k.timeZone).toBe('UTC')
    expect(k.weekStartsOn).toBe('monday')
    expect(k.as).toBe('date_week')
    expect(groupKeyName(k)).toBe('date_week')
    expect(groupKeySourceField(k)).toBe('date')
    expect(groupKeyName('plain')).toBe('plain')
    expect(groupKeySourceField('plain')).toBe('plain')
  })

  it('flattens a dotted source path into the default output key', () => {
    expect(dateTrunc('meta.issued', 'month', { timeZone: 'UTC' }).as).toBe('meta_issued_month')
  })

  it('refuses an unknown unit, a missing timeZone, and an unknown timeZone', () => {
    // @ts-expect-error — unit is not a DateTruncUnit
    expect(() => dateTrunc('date', 'fortnight', { timeZone: 'UTC' })).toThrow(/unit/)
    // @ts-expect-error — timeZone is required, never host-local by default
    expect(() => dateTrunc('date', 'month', {})).toThrow(/timeZone/)
    expect(() => dateTrunc('date', 'month', { timeZone: 'Mars/Olympus' })).toThrow(/timeZone/)
  })
})

describe('dateTrunc > day buckets across DST', () => {
  // US DST 2026: starts Sun 8 Mar (a 23-hour local day), ends Sun 1 Nov (25 hours).
  const day = dateTrunc('date', 'day', { timeZone: 'America/New_York' })

  it('keeps a 23-hour spring-forward day in one bucket', () => {
    expect(truncateDate(at('2026-03-08T05:00:00Z'), day)).toBe('2026-03-08') // 00:00 EST
    expect(truncateDate(at('2026-03-08T07:30:00Z'), day)).toBe('2026-03-08') // 03:30 EDT, post-skip
    expect(truncateDate(at('2026-03-09T03:59:00Z'), day)).toBe('2026-03-08') // 23:59 EDT
    expect(truncateDate(at('2026-03-09T04:00:00Z'), day)).toBe('2026-03-09') // next midnight
  })

  it('keeps a 25-hour fall-back day in one bucket', () => {
    expect(truncateDate(at('2026-11-01T04:00:00Z'), day)).toBe('2026-11-01') // 00:00 EDT
    expect(truncateDate(at('2026-11-01T05:30:00Z'), day)).toBe('2026-11-01') // 01:30 EDT
    expect(truncateDate(at('2026-11-01T06:30:00Z'), day)).toBe('2026-11-01') // 01:30 EST, the repeated hour
    expect(truncateDate(at('2026-11-02T04:59:00Z'), day)).toBe('2026-11-01') // 23:59 EST
    expect(truncateDate(at('2026-11-02T05:00:00Z'), day)).toBe('2026-11-02')
  })
})

describe('dateTrunc > the timezone is the answer, not a decoration', () => {
  it('puts one instant in different day buckets in two zones', () => {
    const instant = at('2026-09-03T22:00:00Z')
    expect(truncateDate(instant, dateTrunc('date', 'day', { timeZone: 'UTC' }))).toBe('2026-09-03')
    expect(truncateDate(instant, dateTrunc('date', 'day', { timeZone: 'Pacific/Auckland' }))).toBe('2026-09-04')
    expect(truncateDate(instant, dateTrunc('date', 'day', { timeZone: 'America/Los_Angeles' }))).toBe('2026-09-03')
  })

  it('puts one instant in different month AND year buckets in two zones', () => {
    const instant = at('2026-01-01T00:30:00Z')
    expect(truncateDate(instant, dateTrunc('date', 'month', { timeZone: 'UTC' }))).toBe('2026-01-01')
    expect(truncateDate(instant, dateTrunc('date', 'month', { timeZone: 'America/New_York' }))).toBe('2025-12-01')
    expect(truncateDate(instant, dateTrunc('date', 'year', { timeZone: 'America/New_York' }))).toBe('2025-01-01')
  })
})

describe('dateTrunc > week start convention', () => {
  // 2026-09-03 is a Thursday.
  it('defaults to an ISO-8601 monday-start week', () => {
    expect(truncateDate(at('2026-09-03T12:00:00Z'), dateTrunc('d', 'week', { timeZone: 'UTC' }))).toBe('2026-08-31')
  })

  it('honours weekStartsOn: sunday', () => {
    const k = dateTrunc('d', 'week', { timeZone: 'UTC', weekStartsOn: 'sunday' })
    expect(truncateDate(at('2026-09-03T12:00:00Z'), k)).toBe('2026-08-30')
  })

  it('leaves a start-of-week instant in its own week (boundary is inclusive at the start)', () => {
    const mon = dateTrunc('d', 'week', { timeZone: 'UTC' })
    expect(truncateDate(at('2026-08-31T00:00:00.000Z'), mon)).toBe('2026-08-31')
    expect(truncateDate(at('2026-08-30T23:59:59.999Z'), mon)).toBe('2026-08-24')
    const sun = dateTrunc('d', 'week', { timeZone: 'UTC', weekStartsOn: 'sunday' })
    expect(truncateDate(at('2026-08-30T00:00:00.000Z'), sun)).toBe('2026-08-30')
    expect(truncateDate(at('2026-08-29T23:59:59.999Z'), sun)).toBe('2026-08-23')
  })

  it('crosses a month and a year boundary inside one week', () => {
    const k = dateTrunc('d', 'week', { timeZone: 'UTC' })
    expect(truncateDate(at('2026-01-01T12:00:00Z'), k)).toBe('2025-12-29')
  })
})

describe('dateTrunc > month / quarter / year boundaries', () => {
  const q = dateTrunc('d', 'quarter', { timeZone: 'UTC' })
  it('maps every month onto its quarter start', () => {
    expect(truncateDate(at('2026-01-01T00:00:00Z'), q)).toBe('2026-01-01')
    expect(truncateDate(at('2026-03-31T23:59:59Z'), q)).toBe('2026-01-01')
    expect(truncateDate(at('2026-04-01T00:00:00Z'), q)).toBe('2026-04-01')
    expect(truncateDate(at('2026-07-01T00:00:00Z'), q)).toBe('2026-07-01')
    expect(truncateDate(at('2026-09-30T23:59:59Z'), q)).toBe('2026-07-01')
    expect(truncateDate(at('2026-10-01T00:00:00Z'), q)).toBe('2026-10-01')
    expect(truncateDate(at('2026-12-31T23:59:59Z'), q)).toBe('2026-10-01')
  })

  it('truncates month and year at an exact boundary instant', () => {
    const m = dateTrunc('d', 'month', { timeZone: 'UTC' })
    const y = dateTrunc('d', 'year', { timeZone: 'UTC' })
    expect(truncateDate(at('2026-02-01T00:00:00.000Z'), m)).toBe('2026-02-01')
    expect(truncateDate(at('2026-01-31T23:59:59.999Z'), m)).toBe('2026-01-01')
    expect(truncateDate(at('2024-02-29T10:00:00Z'), m)).toBe('2024-02-01') // leap day
    expect(truncateDate(at('2026-01-01T00:00:00.000Z'), y)).toBe('2026-01-01')
    expect(truncateDate(at('2025-12-31T23:59:59.999Z'), y)).toBe('2025-01-01')
  })
})

describe('dateTrunc > input coercion', () => {
  const k = dateTrunc('d', 'day', { timeZone: 'UTC' })
  it('accepts Date, epoch ms, and an ISO string', () => {
    expect(truncateDate(new Date('2026-05-04T01:00:00Z'), k)).toBe('2026-05-04')
    expect(truncateDate(Date.parse('2026-05-04T01:00:00Z'), k)).toBe('2026-05-04')
    expect(truncateDate('2026-05-04T01:00:00Z', k)).toBe('2026-05-04')
  })

  it('passes null and undefined through unchanged so the existing bucket semantics hold', () => {
    expect(truncateDate(null, k)).toBe(null)
    expect(truncateDate(undefined, k)).toBe(undefined)
  })

  it('refuses a value that is not a timestamp instead of bucketing it wrong', () => {
    expect(() => truncateDate('not a date', k)).toThrow(/dateTrunc/)
    expect(() => truncateDate(new Date('nope'), k)).toThrow(/dateTrunc/)
    expect(() => truncateDate({}, k)).toThrow(/dateTrunc/)
  })
})

describe('dateTrunc > projection and canonical description', () => {
  it('projects the bucket onto a shallow copy without mutating the source row', () => {
    const rows = [{ id: 'a', d: '2026-05-04T01:00:00Z' }]
    const out = projectDateTruncKeys(rows, [dateTrunc('d', 'month', { timeZone: 'UTC' })])
    expect(out[0]).toEqual({ id: 'a', d: '2026-05-04T01:00:00Z', d_month: '2026-05-01' })
    expect(rows[0]).not.toHaveProperty('d_month')
  })

  it('describes a key deterministically and distinguishes every parameter', () => {
    const base = dateTrunc('d', 'week', { timeZone: 'UTC' })
    expect(describeGroupKey(base)).toBe(describeGroupKey(dateTrunc('d', 'week', { timeZone: 'UTC' })))
    expect(describeGroupKey('plain')).toBe('plain')
    const all = new Set([
      describeGroupKey(base),
      describeGroupKey(dateTrunc('d', 'month', { timeZone: 'UTC' })),
      describeGroupKey(dateTrunc('d', 'week', { timeZone: 'Europe/Berlin' })),
      describeGroupKey(dateTrunc('d', 'week', { timeZone: 'UTC', weekStartsOn: 'sunday' })),
      describeGroupKey(dateTrunc('d', 'week', { timeZone: 'UTC', as: 'bucket' })),
      describeGroupKey(dateTrunc('e', 'week', { timeZone: 'UTC' })),
    ])
    expect(all.size).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// Query.groupBy(dateTrunc(...)) integration
// ---------------------------------------------------------------------------

import { Query, type QuerySource } from '../src/kernel/query/index.js'
import { sum, count, withReduce } from '../src/with-lookup/reduce/index.js'
import { computeQueryHash } from '../src/with-formula/materialized-views/query-hash.js'
import { summarizeUnionPlan } from '../src/with-formula/materialized-views/dependency-analyzer.js'
import type { MaterializedViewSpec } from '../src/with-formula/materialized-views/types.js'
// #1458 — the query DSL ships in four groups; these side-effect imports
// attach the extension methods this file exercises. A consumer on the root
// barrel needs none of them (it imports all three); this file builds its
// Query from `kernel/query` directly, so it takes what it uses.
import '../src/kernel/query/reduce/index.js'

const AGG = withReduce()

interface Invoice {
  id: string
  clientId: string
  issuedAt: string
  amount: number
}

// Two instants late on the last day of a month in UTC. In Auckland (UTC+12)
// they have already rolled into the next month; in New York they have not.
const LEDGER: Invoice[] = [
  { id: 'a', clientId: 'c1', issuedAt: '2026-08-31T22:00:00Z', amount: 100 },
  { id: 'b', clientId: 'c1', issuedAt: '2026-09-01T09:00:00Z', amount: 200 },
  { id: 'c', clientId: 'c2', issuedAt: '2026-09-15T09:00:00Z', amount: 400 },
]

const src = (rows: Invoice[]): QuerySource<Invoice> => ({ snapshot: () => rows })

describe('Query.groupBy(dateTrunc(...))', () => {
  it('buckets by month under the derived key name', () => {
    const rows = new Query<Invoice>(src(LEDGER), undefined, undefined, AGG)
      .groupBy(dateTrunc('issuedAt', 'month', { timeZone: 'UTC' }))
      .aggregate({ total: sum('amount'), n: count() })
      .run()
    expect(rows).toEqual([
      { issuedAt_month: '2026-08-01', total: 100, n: 1 },
      { issuedAt_month: '2026-09-01', total: 600, n: 2 },
    ])
  })

  it('produces different buckets for the same rows in a different timezone', () => {
    const nz = new Query<Invoice>(src(LEDGER), undefined, undefined, AGG)
      .groupBy(dateTrunc('issuedAt', 'month', { timeZone: 'Pacific/Auckland' }))
      .aggregate({ total: sum('amount') })
      .run()
    expect(nz).toEqual([{ issuedAt_month: '2026-09-01', total: 700 }])
  })

  it('composes with a plain field in a multi-key groupBy', () => {
    const rows = new Query<Invoice>(src(LEDGER), undefined, undefined, AGG)
      .groupBy('clientId', dateTrunc('issuedAt', 'quarter', { timeZone: 'UTC', as: 'q' }))
      .aggregate({ total: sum('amount') })
      .run()
    expect(rows).toEqual([
      { clientId: 'c1', q: '2026-07-01', total: 300 },
      { clientId: 'c2', q: '2026-07-01', total: 400 },
    ])
  })

  it('still honours .where() before bucketing', () => {
    const rows = new Query<Invoice>(src(LEDGER), undefined, undefined, AGG)
      .where('clientId', '==', 'c1')
      .groupBy(dateTrunc('issuedAt', 'year', { timeZone: 'UTC' }))
      .aggregate({ total: sum('amount') })
      .run()
    expect(rows).toEqual([{ issuedAt_year: '2026-01-01', total: 300 }])
  })

  it('does not mutate the source records', () => {
    const rows = [...LEDGER]
    new Query<Invoice>(src(rows), undefined, undefined, AGG)
      .groupBy(dateTrunc('issuedAt', 'day', { timeZone: 'UTC' }))
      .aggregate({ n: count() })
      .run()
    expect(rows[0]).not.toHaveProperty('issuedAt_day')
  })
})

// ---------------------------------------------------------------------------
// Declared MV group key → queryHash
// ---------------------------------------------------------------------------

const mvSpec = (groupBy: MaterializedViewSpec<Record<string, unknown>>['groupBy']): MaterializedViewSpec<Record<string, unknown>> =>
  ({
    name: 'monthly',
    unionSources: [{ collection: 'invoices', map: r => r as Record<string, unknown> }],
    groupBy,
    aggregate: { total: sum('amount') },
    rowKey: () => 'k',
    refresh: 'eager',
  }) as MaterializedViewSpec<Record<string, unknown>>

describe('dateTrunc as a DECLARED MV group key folds into queryHash', () => {
  const deps = new Set(['invoices'])

  it('is deterministic across runs for the same declaration', async () => {
    const a = await computeQueryHash('monthly', deps, summarizeUnionPlan(mvSpec(dateTrunc('issuedAt', 'month', { timeZone: 'Europe/Berlin' }))))
    const b = await computeQueryHash('monthly', deps, summarizeUnionPlan(mvSpec(dateTrunc('issuedAt', 'month', { timeZone: 'Europe/Berlin' }))))
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when the unit, the timezone, or the week start changes', async () => {
    const hash = (g: MaterializedViewSpec<Record<string, unknown>>['groupBy']): Promise<string> =>
      computeQueryHash('monthly', deps, summarizeUnionPlan(mvSpec(g)))
    const hashes = await Promise.all([
      hash(dateTrunc('issuedAt', 'month', { timeZone: 'Europe/Berlin' })),
      hash(dateTrunc('issuedAt', 'quarter', { timeZone: 'Europe/Berlin' })),
      hash(dateTrunc('issuedAt', 'month', { timeZone: 'UTC' })),
      hash(dateTrunc('issuedAt', 'week', { timeZone: 'UTC' })),
      hash(dateTrunc('issuedAt', 'week', { timeZone: 'UTC', weekStartsOn: 'sunday' })),
      hash('issuedAt'),
    ])
    expect(new Set(hashes).size).toBe(6)
  })

  it('sorts multi-key declarations so a pure reorder does not force a refresh', async () => {
    const k = dateTrunc('issuedAt', 'month', { timeZone: 'UTC' })
    const a = await computeQueryHash('monthly', deps, summarizeUnionPlan(mvSpec(['clientId', k])))
    const b = await computeQueryHash('monthly', deps, summarizeUnionPlan(mvSpec([k, 'clientId'])))
    expect(a).toBe(b)
  })
})
