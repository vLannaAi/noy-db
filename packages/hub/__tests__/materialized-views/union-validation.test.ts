import { describe, it, expect } from 'vitest'
import { withMaterializedView, MaterializedViewConfigError } from '../../src/index.js'
import { sum } from '../../src/with-lookup/reduce/index.js'
import type { Query } from '../../src/kernel/query/builder.js'

const dummyQuery = (): Query<Record<string, unknown>> =>
  ({}) as Query<Record<string, unknown>>

describe('withMaterializedView UNION validation (#165)', () => {
  it('rejects strategy with both query and unionSources', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-both',
        query: dummyQuery,
        unionSources: [
          { collection: 'a', map: (r) => r as Record<string, unknown> },
          { collection: 'b', map: (r) => r as Record<string, unknown> },
        ],
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).toThrow(MaterializedViewConfigError)
  })

  it('rejects strategy with neither query nor unionSources', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-neither',
        rowKey: () => 'k',
        refresh: 'eager',
      } as Parameters<typeof withMaterializedView>[0]),
    ).toThrow(MaterializedViewConfigError)
  })

  it('accepts a single-arm union — computed-bucket-key aggregates over one collection (#331)', () => {
    expect(() =>
      withMaterializedView({
        name: 'one-arm',
        unionSources: [
          { collection: 'a', map: (r) => r as Record<string, unknown> },
        ],
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).not.toThrow()
  })

  it('rejects an EMPTY unionSources array', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-zero-arms',
        unionSources: [],
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).toThrow(/at least 1/)
  })

  it('rejects unionSources with duplicate collection names', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-dup',
        unionSources: [
          { collection: 'a', map: (r) => r as Record<string, unknown> },
          { collection: 'a', map: (r) => r as Record<string, unknown> },
        ],
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).toThrow(/distinct collections/)
  })

  it('rejects unionSources with empty groupBy array', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-empty-groupby',
        unionSources: [
          { collection: 'a', map: (r) => r as Record<string, unknown> },
          { collection: 'b', map: (r) => r as Record<string, unknown> },
        ],
        groupBy: [],
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).toThrow(/empty array/)
  })

  it('rejects unionSources with aggregate but no groupBy (#169)', () => {
    expect(() =>
      withMaterializedView({
        name: 'bad-aggregate-no-groupby',
        unionSources: [
          { collection: 'a', map: (r) => r as Record<string, unknown> },
          { collection: 'b', map: (r) => r as Record<string, unknown> },
        ],
        aggregate: { total: sum('n') },
        // groupBy intentionally omitted
        rowKey: () => 'k',
        refresh: 'eager',
      }),
    ).toThrow(/aggregate requires groupBy/)
  })

  it('rejects unionSources with predicates (#170 — not yet supported)', () => {
    expect(() =>
      withMaterializedView<{ k: string; n: number }>({
        name: 'bad-predicates-on-union',
        unionSources: [
          {
            collection: 'a',
            map: (r) => ({
              k: String((r as { k: unknown }).k),
              n: Number((r as { n: unknown }).n),
            }),
          },
          {
            collection: 'b',
            map: (r) => ({
              k: String((r as { k: unknown }).k),
              n: Number((r as { n: unknown }).n),
            }),
          },
        ],
        groupBy: 'k',
        aggregate: { total: sum('n') },
        predicates: {
          isPositive: { hash: 'v1', fn: (row) => row.n > 0 },
        },
        rowKey: (row) => row.k,
        refresh: 'eager',
      }),
    ).toThrow(/predicates are not supported on UNION/)
  })

  it('accepts a well-formed UNION strategy', () => {
    expect(() =>
      withMaterializedView<{ k: string; n: number }>({
        name: 'ok',
        unionSources: [
          {
            collection: 'a',
            map: (r) => ({
              k: String((r as { k: unknown }).k),
              n: Number((r as { n: unknown }).n),
            }),
          },
          {
            collection: 'b',
            map: (r) => ({
              k: String((r as { k: unknown }).k),
              n: Number((r as { n: unknown }).n),
            }),
          },
        ],
        groupBy: 'k',
        aggregate: { total: sum('n') },
        rowKey: (row) => row.k,
        refresh: 'eager',
      }),
    ).not.toThrow()
  })
})
