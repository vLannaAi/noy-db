import { describe, expect, it } from 'vitest'
import { GuardRegistry } from '../../src/with-audit/guards/registry.js'

// Minimal guard strategies (only `collection` matters for summary()).
const g = (collection: string) => ({ collection }) as never

describe('GuardRegistry.summary()', () => {
  it('returns [] when empty', () => {
    expect(new GuardRegistry().summary()).toEqual([])
  })
  it('counts guards per collection', () => {
    const r = new GuardRegistry()
    r.register(g('invoices'))
    r.register(g('invoices'))
    r.register(g('payments'))
    const s = r.summary().sort((a, b) => a.collection.localeCompare(b.collection))
    expect(s).toEqual([
      { collection: 'invoices', count: 2 },
      { collection: 'payments', count: 1 },
    ])
  })
})
