import { describe, it, expect, vi } from 'vitest'
import { GuardRegistry } from '../../src/guards/registry.js'
import { withGuard } from '../../src/guards/with-guard.js'
import type { GuardContext } from '../../src/guards/types.js'

const ctx = (existing: unknown = null): GuardContext<any> => ({
  existing: existing as any,
  vault: { collection: () => ({ get: async () => null, list: async () => [] }) },
  userId: 'u1',
  role: 'owner',
})

describe('GuardRegistry', () => {
  it('returns empty array for collections with no registered guards', () => {
    const reg = new GuardRegistry()
    expect(reg.guardsFor('absent')).toEqual([])
  })

  it('registers a guard and returns it by collection name', () => {
    const reg = new GuardRegistry()
    const handle = withGuard<{ s: string }>({ collection: 'widgets', check: () => {} })
    reg.register(handle.spec)
    expect(reg.guardsFor('widgets')).toHaveLength(1)
  })

  it('supports multiple guards on the same collection', () => {
    const reg = new GuardRegistry()
    reg.register(withGuard({ collection: 'widgets', check: () => {} }).spec)
    reg.register(withGuard({ collection: 'widgets', check: () => {} }).spec)
    expect(reg.guardsFor('widgets')).toHaveLength(2)
  })

  it('runChecks executes every guard until one throws', async () => {
    const reg = new GuardRegistry()
    const a = vi.fn()
    const b = vi.fn(() => { throw new Error('blocked') })
    const c = vi.fn()
    reg.register(withGuard<{ x: number }>({ collection: 'w', check: a }).spec)
    reg.register(withGuard<{ x: number }>({ collection: 'w', check: b }).spec)
    reg.register(withGuard<{ x: number }>({ collection: 'w', check: c }).spec)
    await expect(reg.runChecks('w', { x: 1 }, ctx())).rejects.toThrow('blocked')
    expect(a).toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
    expect(c).not.toHaveBeenCalled() // short-circuit
  })

  it('runChecks skips guards without a check function', async () => {
    const reg = new GuardRegistry()
    reg.register(withGuard<{ x: number }>({
      collection: 'w',
      frozenFields: { when: () => false, fields: [] },
    }).spec)
    await expect(reg.runChecks('w', { x: 1 }, ctx())).resolves.toBeUndefined()
  })

  it('collectChange and consumeChanges round-trip', () => {
    const reg = new GuardRegistry()
    reg.beginAmendment()
    reg.collectChange('widgets', 'w1', { name: 'old' }, { name: 'new' })
    reg.collectChange('widgets', 'w2', null, { name: 'fresh' })
    reg.collectChange('lines', 'l1', { amount: 100 }, { amount: 80 })
    const changes = reg.consumeChanges()
    expect(changes.get('widgets')).toHaveLength(2)
    expect(changes.get('lines')).toHaveLength(1)
    // beginAmendment resets state
    reg.beginAmendment()
    expect(reg.consumeChanges().size).toBe(0)
  })
})
