import { describe, it, expect } from 'vitest'
import { withMaterializedView } from '../../src/with-formula/materialized-views/with-materialized-view.js'
import type { Query } from '../../src/query/builder.js'

const dummyQuery = (): Query<Record<string, unknown>> => ({} as Query<Record<string, unknown>>)

describe('withMaterializedView factory', () => {
  it('returns a handle with __noydb_strategy: "materialized-view"', () => {
    const handle = withMaterializedView({
      name: 'totals',
      query: dummyQuery,
      rowKey: (r) => String(r.id),
      refresh: 'eager',
    })
    expect(handle.__noydb_strategy).toBe('materialized-view')
    expect(handle.spec.name).toBe('totals')
  })

  it('preserves the spec verbatim', () => {
    const query = dummyQuery
    const rowKey = (r: Record<string, unknown>): string => String(r.k)
    const handle = withMaterializedView({
      name: 'agg',
      query,
      rowKey,
      refresh: 'lazy',
      output: { collection: 'agg-out' },
      onEmpty: 'delete',
      strict: true,
      maxRows: 50_000,
    })
    expect(handle.spec.query).toBe(query)
    expect(handle.spec.rowKey).toBe(rowKey)
    expect(handle.spec.refresh).toBe('lazy')
    expect(handle.spec.output?.collection).toBe('agg-out')
    expect(handle.spec.onEmpty).toBe('delete')
    expect(handle.spec.strict).toBe(true)
    expect(handle.spec.maxRows).toBe(50_000)
  })

  it('rejects empty name', () => {
    expect(() => withMaterializedView({ name: '', query: dummyQuery, rowKey: (r) => String(r.id), refresh: 'eager' })).toThrow(/name/i)
  })

  it('rejects missing rowKey', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      withMaterializedView({ name: 'x', query: dummyQuery, refresh: 'eager' } as any),
    ).toThrow(/rowKey/i)
  })

  it('rejects invalid refresh value', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      withMaterializedView({ name: 'x', query: dummyQuery, rowKey: (r) => String(r.id), refresh: 'never' as any }),
    ).toThrow(/refresh/i)
  })
})
