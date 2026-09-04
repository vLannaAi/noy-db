import { describe, it, expect } from 'vitest'
import { createNoydb, withGuard, RecordLockedError, CollectionNotHydratedError } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

// #1414 — a cold (never-read) collection used to answer every query terminal
// as EMPTY, forever, with no throw and no warning. Guards inherited the same
// unhydrated source through `ReadOnlyVaultFacade`, which produced both a
// silent bypass (a write a warm instance refuses, committing) and a false
// rejection (a valid write refused). Both are regression-tested below through
// a real `withGuard` + `guardStrategies` setup, not a unit stub.

function toMemory(): { store: NoydbStore } {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    store: {
      capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
      async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
      async put(v, c, i, env) { data.set(k(v, c, i), env) },
      async delete(v, c, i) { data.delete(k(v, c, i)) },
      async list(v, c) {
        const prefix = `${v}/${c}/`
        return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
      },
      async loadAll(v) {
        const out: Record<string, Record<string, EncryptedEnvelope>> = {}
        for (const [key, env] of data) {
          const [vname, cname, id] = key.split('/')
          if (vname === v) {
            out[cname!] = out[cname!] ?? {}
            out[cname!]![id!] = env
          }
        }
        return out
      },
      async saveAll(v, payload) {
        for (const c of Object.keys(payload)) {
          for (const i of Object.keys(payload[c]!)) data.set(k(v, c, i), payload[c]![i]!)
        }
      },
    },
  }
}

interface Payment extends Record<string, unknown> { id: string; amount: number }
interface Receipt extends Record<string, unknown> { id: string; paymentId: string; status: string }
interface Client extends Record<string, unknown> { id: string; entityId: string }

const SECRET = 'cold-collection-1414-regression-secret'

/** A guard that refuses an edit to a payment carrying a SENT receipt (#1414 bypass). */
const frozenByReceipt = withGuard<Payment>({
  collection: 'payments',
  check: async (incoming, { vault }) => {
    const sent = await vault.collection<Receipt>('receipts')
      .query().where('paymentId', '==', incoming.id).toArray()
    if (sent.some(r => r.status === 'SENT')) {
      throw new RecordLockedError('payments', incoming.id, 'PAY-FROZEN-001: a SENT receipt exists')
    }
  },
})

/** A guard that requires the receipt's entity to resolve to a client (#1414 false rejection). */
const clientMustResolve = withGuard<Receipt>({
  collection: 'receipts',
  check: async (incoming, { vault }) => {
    const clients = await vault.collection<Client>('clients')
      .query().where('entityId', '==', incoming.paymentId).toArray()
    if (clients.length === 0) {
      throw new RecordLockedError('receipts', incoming.id, 'RCT-CLIENT-CONSISTENT-001: resolves to no client')
    }
  },
})

async function seed(store: NoydbStore): Promise<void> {
  const db = await createNoydb({ store, user: 'ann', secret: SECRET })
  const v = await db.openVault('books')
  await v.collection<Payment>('payments').put('pay-104', { id: 'pay-104', amount: 100 })
  await v.collection<Receipt>('receipts').put('rct-1', { id: 'rct-1', paymentId: 'pay-104', status: 'SENT' })
  await v.collection<Client>('clients').put('cli-1', { id: 'cli-1', entityId: 'ent-c3' })
}

type Guards = NonNullable<Parameters<typeof createNoydb>[0]['guardStrategies']>

function reopen(store: NoydbStore, guardStrategies: Guards) {
  return createNoydb({ store, user: 'ann', secret: SECRET, guardStrategies })
}

describe('#1414 — a cold collection must not answer by absence', () => {
  describe('guards (the reason this is severity-HIGH)', () => {
    it('does NOT silently bypass a guard whose cross-collection query runs cold', async () => {
      const { store } = toMemory()
      await seed(store)

      // Warm control: on an instance that has read `receipts`, the edit is refused.
      const warm = await reopen(store, [frozenByReceipt])
      const wv = await warm.openVault('books')
      await wv.collection<Receipt>('receipts').list()
      await expect(
        wv.collection<Payment>('payments').put('pay-104', { id: 'pay-104', amount: 777 }),
      ).rejects.toBeInstanceOf(RecordLockedError)

      // Cold: only `payments` has been touched; `receipts` was never read. The
      // guard's own query must still see the SENT receipt.
      const cold = await reopen(store, [frozenByReceipt])
      const cv = await cold.openVault('books')
      await cv.collection<Payment>('payments').get('pay-104')
      await expect(
        cv.collection<Payment>('payments').put('pay-104', { id: 'pay-104', amount: 777 }),
      ).rejects.toBeInstanceOf(RecordLockedError)

      // And the bypassed write must not have persisted.
      const check = await reopen(store, [])
      const chv = await check.openVault('books')
      expect((await chv.collection<Payment>('payments').get('pay-104'))?.amount).toBe(100)
    })

    it('does NOT falsely reject a valid write whose guard query runs cold', async () => {
      const { store } = toMemory()
      const db0 = await createNoydb({ store, user: 'ann', secret: SECRET })
      const v0 = await db0.openVault('books')
      await v0.collection<Client>('clients').put('cli-1', { id: 'cli-1', entityId: 'ent-c3' })

      // Warm control: the client resolves, so the put is accepted.
      const warm = await reopen(store, [clientMustResolve])
      const wv = await warm.openVault('books')
      await wv.collection<Client>('clients').list()
      await expect(
        wv.collection<Receipt>('receipts').put('rct-2', { id: 'rct-2', paymentId: 'ent-c3', status: 'DRAFT' }),
      ).resolves.not.toThrow()

      // Cold: `clients` was never read on this instance. Same put, same answer.
      const cold = await reopen(store, [clientMustResolve])
      const cv = await cold.openVault('books')
      await expect(
        cv.collection<Receipt>('receipts').put('rct-3', { id: 'rct-3', paymentId: 'ent-c3', status: 'DRAFT' }),
      ).resolves.not.toThrow()
    })
  })

  describe('the awaited path hydrates', () => {
    it('await query().toArray() on a cold collection returns the rows, not []', async () => {
      const { store } = toMemory()
      await seed(store)
      const db = await reopen(store, [])
      const v = await db.openVault('books')
      const rows = await v.collection<Receipt>('receipts').query().toArray()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.id).toBe('rct-1')
    })

    it('await-hydrates for a filtered query, a count, an exists and a first', async () => {
      const { store } = toMemory()
      await seed(store)
      const db = await reopen(store, [])
      const v = await db.openVault('books')
      const c = v.collection<Receipt>('receipts')
      expect(await c.query().where('paymentId', '==', 'pay-104').toArray()).toHaveLength(1)

      const db2 = await reopen(store, [])
      const c2 = (await db2.openVault('books')).collection<Receipt>('receipts')
      expect(await c2.query().count()).toBe(1)

      const db3 = await reopen(store, [])
      const c3 = (await db3.openVault('books')).collection<Receipt>('receipts')
      expect(await c3.query().exists()).toBe(true)

      const db4 = await reopen(store, [])
      const c4 = (await db4.openVault('books')).collection<Receipt>('receipts')
      expect((await c4.query().first())?.id).toBe('rct-1')
    })

    it('is idempotent — a second await answers the same', async () => {
      const { store } = toMemory()
      await seed(store)
      const db = await reopen(store, [])
      const c = (await db.openVault('books')).collection<Receipt>('receipts')
      expect(await c.query().toArray()).toHaveLength(1)
      expect(await c.query().toArray()).toHaveLength(1)
    })
  })

  describe('sync terminals refuse to answer while cold', () => {
    // The terminal itself returns a pending result (so the awaited form works);
    // the error is raised the moment that value is USED synchronously.
    const uses: ReadonlyArray<readonly [string, (c: { query(): any }) => unknown]> = [
      ['toArray', c => c.query().toArray().length],
      ['toArray/spread', c => [...c.query().toArray()]],
      ['count', c => c.query().count() + 0],
      ['exists', c => `${c.query().exists()}`],
      ['first', c => (c.query().first() as { id: string }).id],
      ['ids', c => c.query().ids().join(',')],
      ['page', c => c.query().orderBy('id').page().rows],
      ['live().value', c => c.query().live().value],
    ]

    for (const [name, use] of uses) {
      it(`${name} throws CollectionNotHydratedError cold, and answers after a hydrating read`, async () => {
        const { store } = toMemory()
        await seed(store)

        const cold = await reopen(store, [])
        const cc = (await cold.openVault('books')).collection<Receipt>('receipts')
        expect(() => use(cc as never)).toThrow(CollectionNotHydratedError)

        const warm = await reopen(store, [])
        const wc = (await warm.openVault('books')).collection<Receipt>('receipts')
        await wc.list()
        expect(() => use(wc as never)).not.toThrow()
      })
    }

    it('names the collection and points at the remedy', async () => {
      const { store } = toMemory()
      await seed(store)
      const db = await reopen(store, [])
      const c = (await db.openVault('books')).collection<Receipt>('receipts')
      try {
        void c.query().toArray().length
        expect.unreachable('should have thrown')
      } catch (e) {
        const err = e as CollectionNotHydratedError
        expect(err).toBeInstanceOf(CollectionNotHydratedError)
        expect(err.code).toBe('COLLECTION_NOT_HYDRATED')
        expect(err.collection).toBe('receipts')
        expect(err.terminal).toBe('toArray')
        expect(err.message).toContain('books/receipts')
        expect(err.message).toContain('await collection.list()')
      }
    })

    it('a genuinely empty but HYDRATED collection still answers empty, without throwing', async () => {
      const { store } = toMemory()
      await seed(store)
      const db = await reopen(store, [])
      const c = (await db.openVault('books')).collection<Receipt>('empties')
      await c.list()
      expect(c.query().toArray()).toEqual([])
      expect(c.query().count()).toBe(0)
      expect(c.query().exists()).toBe(false)
    })
  })

  describe('explain() distinguishes "not loaded" from "no indexes"', () => {
    it('says NOT HYDRATED while cold and no-indexes once loaded', async () => {
      const { store } = toMemory()
      await seed(store)
      const db = await reopen(store, [])
      const c = (await db.openVault('books')).collection<Receipt>('receipts')

      const cold = c.query().explain()
      const coldSource = cold.nodes.find(n => n.op === 'source')!
      expect(coldSource.detail).toContain('NOT HYDRATED')
      expect(coldSource.detail).not.toBe('snapshot (no indexes)')
      expect(coldSource.notes.join(' ')).toContain('not hydrated')

      await c.list()
      const warmSource = c.query().explain().nodes.find(n => n.op === 'source')!
      expect(warmSource.detail).toBe('snapshot (no indexes)')
      expect(warmSource.notes.join(' ')).not.toContain('not hydrated')
    })
  })
})
