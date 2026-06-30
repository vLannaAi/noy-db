import { describe, it, expect } from 'vitest'
import { withGuard } from '../../src/with-audit/guards/with-guard.js'

describe('withGuard factory', () => {
  it('returns a handle with __noydb_strategy: "guard"', () => {
    const handle = withGuard<{ status: string }>({
      collection: 'widgets',
      check: () => {},
    })
    expect(handle.__noydb_strategy).toBe('guard')
    expect(handle.spec.collection).toBe('widgets')
  })

  it('preserves the full spec verbatim', () => {
    const check = async () => {}
    const invariant = async () => {}
    const handle = withGuard<{ id: string; amount: number; status: string }>({
      collection: 'lines',
      check,
      frozenFields: { when: r => r.status === 'issued', fields: ['amount'] },
      amendment: { roles: ['admin'], invariant },
    })
    expect(handle.spec.check).toBe(check)
    expect(handle.spec.frozenFields?.fields).toEqual(['amount'])
    expect(handle.spec.amendment?.invariant).toBe(invariant)
    expect(handle.spec.amendment?.roles).toEqual(['admin'])
  })

  it('rejects an empty collection name', () => {
    expect(() => withGuard({ collection: '' })).toThrow(/collection/i)
  })
})
