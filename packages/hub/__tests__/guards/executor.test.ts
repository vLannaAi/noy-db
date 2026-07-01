import { describe, it, expect, vi } from 'vitest'
import { GuardExecutor } from '../../src/with-audit/guards/executor.js'
import { withGuard } from '../../src/with-audit/guards/with-guard.js'
import { FieldFrozenError, InvariantError } from '../../src/kernel/errors.js'
import type { GuardContext } from '../../src/with-audit/guards/types.js'

interface Invoice extends Record<string, unknown> {
  total: number
  notes: string
  status: 'draft' | 'issued'
}

const ctx = (existing: Invoice | null = null): GuardContext<Invoice> => ({
  existing,
  vault: { collection: () => ({ get: async () => null, list: async () => [], query: () => { throw new Error('not used') } }) },
  userId: 'u',
  role: 'owner',
})

describe('GuardExecutor.checkFrozenFields', () => {
  const guard = withGuard<Invoice>({
    collection: 'invoices',
    frozenFields: { when: r => r.status === 'issued', fields: ['total'] },
  }).spec

  it('passes when no `when` is registered', async () => {
    const g = withGuard<Invoice>({ collection: 'invoices' }).spec
    await expect(
      GuardExecutor.checkFrozenFields(g, 'inv1', { total: 100, notes: 'a', status: 'draft' }, { total: 200, notes: 'a', status: 'draft' }),
    ).resolves.toBeUndefined()
  })

  it('passes when existing fails the `when` predicate', async () => {
    await expect(
      GuardExecutor.checkFrozenFields(
        guard, 'inv1',
        { total: 100, notes: 'a', status: 'draft' },
        { total: 200, notes: 'b', status: 'draft' },
      ),
    ).resolves.toBeUndefined()
  })

  it('passes when existing is null (insert)', async () => {
    await expect(
      GuardExecutor.checkFrozenFields(guard, 'inv1', null, { total: 100, notes: '', status: 'draft' }),
    ).resolves.toBeUndefined()
  })

  it('passes when no frozen field changed', async () => {
    await expect(
      GuardExecutor.checkFrozenFields(
        guard, 'inv1',
        { total: 100, notes: 'a', status: 'issued' },
        { total: 100, notes: 'b', status: 'issued' },
      ),
    ).resolves.toBeUndefined()
  })

  it('throws FieldFrozenError when a frozen field changed', async () => {
    try {
      await GuardExecutor.checkFrozenFields(
        guard, 'inv1',
        { total: 100, notes: 'a', status: 'issued' },
        { total: 200, notes: 'a', status: 'issued' },
      )
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(FieldFrozenError)
      expect((e as FieldFrozenError).fields).toEqual(['total'])
    }
  })

  it('lists all changed frozen fields', async () => {
    const multi = withGuard<Invoice>({
      collection: 'invoices',
      frozenFields: { when: r => r.status === 'issued', fields: ['total', 'notes'] },
    }).spec
    try {
      await GuardExecutor.checkFrozenFields(
        multi, 'inv1',
        { total: 100, notes: 'a', status: 'issued' },
        { total: 200, notes: 'b', status: 'issued' },
      )
      throw new Error('expected throw')
    } catch (e) {
      expect((e as FieldFrozenError).fields).toEqual(['total', 'notes'])
    }
  })
})

describe('GuardExecutor.runInvariant', () => {
  it('runs the invariant; passes if it does not throw', async () => {
    const inv = vi.fn()
    const guard = withGuard<{ amount: number }>({
      collection: 'lines',
      amendment: { roles: ['admin'], invariant: inv },
    }).spec
    await GuardExecutor.runInvariant(guard, [{ before: { amount: 1 }, after: { amount: 1 } }], ctx() as any)
    expect(inv).toHaveBeenCalled()
  })

  it('wraps non-InvariantError throws into InvariantError', async () => {
    const guard = withGuard<{ amount: number }>({
      collection: 'lines',
      amendment: { roles: ['admin'], invariant: () => { throw new Error('plain') } },
    }).spec
    await expect(
      GuardExecutor.runInvariant(guard, [], ctx() as any),
    ).rejects.toThrow(InvariantError)
  })

  it('rethrows InvariantError unchanged', async () => {
    const original = new InvariantError('explicit')
    const guard = withGuard<{ amount: number }>({
      collection: 'lines',
      amendment: { roles: ['admin'], invariant: () => { throw original } },
    }).spec
    await expect(
      GuardExecutor.runInvariant(guard, [], ctx() as any),
    ).rejects.toBe(original)
  })
})
