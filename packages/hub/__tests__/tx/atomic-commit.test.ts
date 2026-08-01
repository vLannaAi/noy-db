/**
 * #906 — `db.transaction(fn)` commits through ONE `store.tx()` batch.
 *
 * The payoff of the #893 prepare/commit split: when the store declares
 * `txAtomic` AND the staged batch is statically safe (`canCommitAtomically`),
 * `runTransaction` prepares every op (encrypt, resolve prior version, mint the
 * #589 marker) with zero observable side effects, submits the whole write set
 * as a single `store.tx(ops)` call, then finalizes each op — history snapshot,
 * ledger entry, cache/index update and change event — in staged order.
 *
 * Anything else keeps today's per-op OCC path byte-for-byte: no `txAtomic`, an
 * amendment, a duplicate id, a derivation/MV/CRDT/unique/refs collection.
 *
 * The ordering change this buys is deliberate and asserted below: on the atomic
 * path EVERY side effect happens AFTER the bytes are durable, instead of
 * interleaving per op the way the OCC loop does.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { toMemory } from '../../../to-memory/src/index.js'
import { ConflictError, InvariantError, MigrationRequiredError, SchemaFenceError, createNoydb, withDerivation } from '../../src/index.js'
import { coordinatedCutover } from '../../src/with-shape/schema-update/index.js'
import { withTransactions } from '../../src/with-commit/tx/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { withSync } from '../../src/with-sync/index.js'
import { ref } from '../../src/kernel/refs.js'
import type { Noydb } from '../../src/index.js'
import type { ChangeEvent, NoydbStore, TxOp } from '../../src/kernel/types.js'

const SECRET = 'atomic-commit-test-secret-2026'

interface Invoice extends Record<string, unknown> { amount: number; status: string }

interface Instrumented {
  store: NoydbStore
  /** Every store call, in order: `tx:<n>`, `put:<coll>/<id>`, `delete:<coll>/<id>`. */
  calls: string[]
  /** The op arrays handed to `tx()`, in submission order. */
  batches: TxOp[][]
}

/**
 * Wrap a store so every write is observable (idiom copied from
 * `prepare-commit-put.test.ts` / `atomic-eligibility.test.ts`).
 *
 * `txThrows` rejects the batch WITHOUT forwarding it — the store applied
 * nothing, which is what an all-or-nothing store guarantees on failure.
 * `beforeTx` runs while the batch is in flight (after the hub prepared every
 * envelope, before the store sees it) — the concurrent-writer hook.
 */
function instrument(
  base: NoydbStore = toMemory(),
  opts: { txThrows?: Error; beforeTx?: () => Promise<void> | void } = {},
): Instrumented {
  const calls: string[] = []
  const batches: TxOp[][] = []
  const store: NoydbStore = {
    ...base,
    async put(v, c, id, env, expected) {
      calls.push(`put:${c}/${id}`)
      return base.put(v, c, id, env, expected)
    },
    async delete(v, c, id) {
      calls.push(`delete:${c}/${id}`)
      return base.delete(v, c, id)
    },
    async tx(ops) {
      batches.push([...ops])
      calls.push(`tx:${ops.length}`)
      if (opts.beforeTx) await opts.beforeTx()
      if (opts.txThrows) throw opts.txThrows
      return base.tx!(ops)
    },
  }
  return { store, calls, batches }
}

/** Store calls that touch the batch bodies (not `_ledger` / `_history` internals). */
const bodyWrites = (calls: string[]): string[] =>
  calls.filter(c => !c.startsWith('tx:') && !c.includes(':_'))

async function open(store: NoydbStore, extra: Record<string, unknown> = {}): Promise<Noydb> {
  const db = await createNoydb({
    store,
    user: 'owner',
    secret: SECRET,
    transactionsStrategy: withTransactions(),
    ...extra,
  })
  await db.openVault('acme')
  return db
}

/** Full store dump for the byte-identity assertion. */
async function dump(store: NoydbStore, collections: string[]): Promise<string> {
  const out: Record<string, unknown> = {}
  for (const c of collections) {
    for (const id of await store.list('acme', c)) {
      out[`${c}/${id}`] = await store.get('acme', c, id)
    }
  }
  return JSON.stringify(out)
}

const TOUCHED = ['invoices', 'payments', '_ledger', '_history']

describe('#906 — db.transaction commits through store.tx() on txAtomic stores', () => {
  it('submits exactly ONE tx() call for an eligible batch — no per-op store writes', async () => {
    const { store, calls, batches } = instrument()
    const db = await open(store)
    calls.length = 0

    await db.transaction((tx) => {
      tx.vault('acme').collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'paid' })
      tx.vault('acme').collection<Invoice>('payments').put('pay-1', { amount: 100, status: 'paid' })
    })

    expect(calls.filter(c => c.startsWith('tx:'))).toEqual(['tx:2'])
    expect(bodyWrites(calls)).toEqual([]) // the batch bodies never went through put()
    expect(batches[0]!.map(o => `${o.type}:${o.collection}/${o.id}`)).toEqual([
      'put:invoices/inv-1',
      'put:payments/pay-1',
    ])
    // …and the records really are readable afterwards.
    expect(await db.vault('acme').collection<Invoice>('invoices').get('inv-1')).toEqual({ amount: 100, status: 'paid' })
    expect(await db.vault('acme').collection<Invoice>('payments').get('pay-1')).toEqual({ amount: 100, status: 'paid' })
  })

  it('a rejected tx() leaves the store byte-identical, with no ledger entries and no change events', async () => {
    const rejection = new Error('batch rejected by the store')
    const { store, calls } = instrument(toMemory(), { txThrows: rejection })
    const db = await open(store, { historyStrategy: withHistory() })
    // Seed so the batch is an UPDATE — a failed update is the case where a
    // stray compensating write would be visible in the dump.
    await db.vault('acme').collection<Invoice>('invoices').put('inv-1', { amount: 50, status: 'draft' })
    const ledgerBefore = (await db.vault('acme').ledger().entries()).length
    expect(ledgerBefore).toBe(1) // the seed write — so "no NEW entries" is a real assertion
    const before = await dump(store, TOUCHED)

    const events: ChangeEvent[] = []
    db.on('change', (e) => events.push(e))
    calls.length = 0

    await expect(
      db.transaction((tx) => {
        tx.vault('acme').collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'paid' })
        tx.vault('acme').collection<Invoice>('payments').put('pay-1', { amount: 100, status: 'paid' })
      }),
    ).rejects.toBe(rejection) // surfaces as-is, not wrapped

    expect(await dump(store, TOUCHED)).toBe(before)
    expect((await db.vault('acme').ledger().entries()).length).toBe(ledgerBefore)
    expect(events).toEqual([])
    // No revert pass either — nothing was applied, so nothing to unwind.
    // (`_keyring` is deliberately outside the dump: the first write to a
    // not-yet-keyed collection mints and persists its DEK during encryption,
    // on this path and on the OCC path alike. A spare collection key is not
    // record state.)
    expect(calls.filter(c => c.startsWith('tx:'))).toEqual(['tx:2'])
    expect(bodyWrites(calls)).toEqual([])
  })

  it('a store without txAtomic takes the OCC path unchanged', async () => {
    const memory = toMemory()
    const occ: NoydbStore = {
      ...memory,
      capabilities: { ...memory.capabilities!, txAtomic: false },
    }
    const { store, calls } = instrument(occ)
    const db = await open(store)
    calls.length = 0

    await db.transaction((tx) => {
      tx.vault('acme').collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'paid' })
      tx.vault('acme').collection<Invoice>('payments').put('pay-1', { amount: 100, status: 'paid' })
    })

    expect(calls.filter(c => c.startsWith('tx:'))).toEqual([])
    expect(bodyWrites(calls)).toEqual(['put:invoices/inv-1', 'put:payments/pay-1'])
  })

  it('an ineligible batch (derivation registered) takes the OCC path', async () => {
    const derivation = withDerivation({
      source: 'invoices',
      deterministic: true,
      outputs: { summary: { shape: 'record', collection: 'summaries' } },
      derive: () => ({ summary: { amount: 1 } }),
      lifecycle: 'eager',
    })
    const { store, calls } = instrument()
    const db = await open(store, { derivationStrategies: [derivation] })
    db.vault('acme').collection<Invoice>('invoices')
    calls.length = 0

    await db.transaction((tx) => {
      tx.vault('acme').collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'paid' })
    })

    expect(calls.filter(c => c.startsWith('tx:'))).toEqual([])
    expect(bodyWrites(calls)).toContain('put:invoices/inv-1')
  })

  it('keeps hub.writeQueue.pending truthful across the batch', async () => {
    // The atomic path bypasses `Collection.put()`, where an ordinary write
    // enters the tracker — so the batch is tracked at the transaction layer.
    let pendingDuringTx = false
    let db!: Noydb
    const { store } = instrument(toMemory(), { beforeTx: () => { pendingDuringTx = db.writeQueue.pending } })
    db = await open(store)

    expect(db.writeQueue.pending).toBe(false)
    await db.transaction((tx) => {
      tx.vault('acme').collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'paid' })
    })

    expect(pendingDuringTx).toBe(true)
    expect(db.writeQueue.pending).toBe(false) // settled
  })

  it('an onBeforeWrite hook keeps the batch on the OCC path — refusal power gates (#931)', async () => {
    // A before-hook may REFUSE a write (throw aborts it), and it runs inside
    // `Collection.put()`, which the atomic path bypasses — so its presence
    // still forces the per-op path, where it fires per op as ever.
    const { store, calls } = instrument()
    const db = await open(store)
    const seen: string[] = []
    db.onBeforeWrite((e) => { seen.push(e.docId) })
    calls.length = 0

    await db.transaction((tx) => {
      const inv = tx.vault('acme').collection<Invoice>('invoices')
      inv.put('inv-1', { amount: 100, status: 'paid' })
      inv.put('inv-2', { amount: 200, status: 'paid' })
    })

    expect(calls.filter(c => c.startsWith('tx:'))).toEqual([])
    expect(seen).toEqual(['inv-1', 'inv-2'])
  })

  it('an onAfterWrite hook no longer gates — the batch commits atomically, the hook fires per op AFTER the batch lands (#931)', async () => {
    // After-hooks are observers: they cannot refuse a write, so instead of
    // keeping every collection on the OCC path (the pre-#931 db-global
    // blanket, which cost multi-tab and forget-subject apps the atomic path
    // entirely), the atomic path fires them per op post-finalize, in staged
    // order, with a faithful WriteEvent.
    const log: string[] = []
    const memory = toMemory()
    const store: NoydbStore = {
      ...memory,
      async tx(ops) {
        const out = await memory.tx!(ops)
        log.push('tx') // recorded only once the batch has LANDED
        return out
      },
    }
    const db = await open(store)
    await db.vault('acme').collection<Invoice>('invoices').put('inv-1', { amount: 50, status: 'draft' })
    db.onAfterWrite((e) => { log.push(`after:${e.docId}:${e.op}@${e.baseVersion}->${e.version}`) })
    log.length = 0

    await db.transaction((tx) => {
      const inv = tx.vault('acme').collection<Invoice>('invoices')
      inv.put('inv-1', { amount: 100, status: 'paid' })
      inv.put('inv-2', { amount: 200, status: 'paid' })
    })

    expect(log).toEqual(['tx', 'after:inv-1:update@1->2', 'after:inv-2:create@0->1'])
  })

  it('history, ledger and change events fire per op in staged order AFTER the batch lands', async () => {
    const log: string[] = []
    const memory = toMemory()
    const store: NoydbStore = {
      ...memory,
      async put(v, c, id, env, expected) {
        if (c === '_ledger') log.push('ledger')
        if (c === '_history') log.push(`history:${id.split(':')[1]}`)
        return memory.put(v, c, id, env, expected)
      },
      async tx(ops) {
        const out = await memory.tx!(ops)
        log.push('tx') // recorded only once the batch has LANDED
        return out
      },
    }
    const db = await open(store, { historyStrategy: withHistory() })
    const v = db.vault('acme')
    await v.collection<Invoice>('invoices').put('inv-1', { amount: 50, status: 'draft' })
    await v.collection<Invoice>('invoices').put('inv-2', { amount: 60, status: 'draft' })
    db.on('change', (e) => log.push(`event:${e.id}`))
    log.length = 0

    await db.transaction((tx) => {
      const inv = tx.vault('acme').collection<Invoice>('invoices')
      inv.put('inv-1', { amount: 100, status: 'paid' })
      inv.put('inv-2', { amount: 200, status: 'paid' })
    })

    // The batch commits FIRST; then each op's tail runs, in staged order.
    expect(log).toEqual([
      'tx',
      'history:inv-1', 'ledger', 'event:inv-1',
      'history:inv-2', 'ledger', 'event:inv-2',
    ])
  })

  it('every TxOp carries expectedVersion — a concurrent writer fails the batch with ConflictError and applies nothing', async () => {
    const memory = toMemory()
    let raced = false
    const { store, calls, batches } = instrument(memory, {
      beforeTx: async () => {
        if (raced) return
        raced = true
        // A writer landing between the body returning and the batch reaching
        // the store: bumps inv-1 to v2 under the batch's feet.
        const live = (await memory.get('acme', 'invoices', 'inv-1'))!
        await memory.put('acme', 'invoices', 'inv-1', { ...live, _v: live._v + 1 })
      },
    })
    const db = await open(store)
    await db.vault('acme').collection<Invoice>('invoices').put('inv-1', { amount: 50, status: 'draft' })
    calls.length = 0

    const err: unknown = await db.transaction((tx) => {
      const inv = tx.vault('acme').collection<Invoice>('invoices')
      inv.put('inv-1', { amount: 100, status: 'paid' })
      inv.put('inv-2', { amount: 200, status: 'paid' })
    }).then(() => null, (e: unknown) => e)

    // The store's ConflictError surfaces unwrapped. Matched by name, not
    // `instanceof`: `to-memory` binds the PUBLISHED `@noy-db/hub/to` seam, so
    // its error class is a different identity from this suite's src import.
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).constructor.name).toBe(ConflictError.name)
    expect(String(err)).toContain('expected v1, found v2')

    // Every leg carried the version captured in the pre-flight snapshot.
    expect(batches[0]!.map(o => o.expectedVersion)).toEqual([1, 0])
    // Nothing from the batch was applied: inv-2 never appeared, inv-1 still
    // holds the racing writer's version (only the racer's put is in `calls`).
    expect(await memory.get('acme', 'invoices', 'inv-2')).toBeNull()
    expect((await memory.get('acme', 'invoices', 'inv-1'))!._v).toBe(2)
    expect(calls.filter(c => c.startsWith('tx:'))).toEqual(['tx:2'])
  })

  it('a failing commit-time invariant still reverts the batch', async () => {
    // The invariant phase lives AFTER Phase 2 and runs on either path; its
    // revert walks the same `ctx._executed` plan the prepare loop records.
    const failing = {
      scope: 'invoices',
      check: () => { throw new Error('R1: no paid invoices today') },
    }
    const { store, calls } = instrument()
    const db = await open(store, { transactionsStrategy: withTransactions({ invariants: [failing] }) })
    const inv = db.vault('acme').collection<Invoice>('invoices')
    await inv.put('inv-1', { amount: 50, status: 'draft' })

    await expect(
      db.transaction((tx) => {
        const c = tx.vault('acme').collection<Invoice>('invoices')
        c.put('inv-1', { amount: 100, status: 'paid' })
        c.put('inv-2', { amount: 200, status: 'paid' })
      }),
    ).rejects.toBeInstanceOf(InvariantError)

    expect(await inv.get('inv-1')).toEqual({ amount: 50, status: 'draft' })
    expect(await inv.get('inv-2')).toBeNull()
    // …and it really was the atomic path that got reverted: one tx() for the
    // commit, then a second for the revert itself (#886 sends the whole revert
    // as one batch on a txAtomic store).
    expect(calls.filter(c => c.startsWith('tx:'))).toEqual(['tx:2', 'tx:2'])
  })
})

/**
 * Fix round 1 — the schema write gates.
 *
 * `Collection.put()` / `.delete()` assert `schemaUpdateGate.assertWritable()`
 * and `schemaFence.assertWritable(name)` before anything else; neither lives in
 * the prepare halves the atomic path calls, and the fence is wired on EVERY
 * collection. Without an explicit assertion the atomic path would write straight
 * through a paused vault. Driven with the real fence (the pending-cutover state
 * from `coordinated-cutover-integration.test.ts`) rather than a stub — that
 * idiom is only a few lines and proves the production wiring, not a mock.
 */
describe('#906 — the atomic path honours the schema write gates', () => {
  const oldSchema = z.object({ id: z.string(), total: z.number() })
  const newSchema = z.object({ id: z.string(), amount: z.object({ gross: z.number() }) })

  it('a pending cutover refuses an atomic batch with the same error as put(), applying nothing', async () => {
    const { store, calls } = instrument()
    // gen 0: seed the old shape.
    const seed = await createNoydb({ store, user: 'owner', secret: SECRET, transactionsStrategy: withTransactions() })
    const v0 = await seed.openVault('acme')
    v0.collection('invoices', { schema: oldSchema, persistJsonSchema: true })
    await v0._drainPendingSchemaWrites()

    // Reopen with a NON-additive schema + coordinatedCutover ⇒ cutover-pending.
    const db = await createNoydb({ store, user: 'owner', secret: SECRET, transactionsStrategy: withTransactions() })
    const v = await db.openVault('acme')
    const invoices = v.collection('invoices', {
      schema: newSchema, persistJsonSchema: true,
      schemaUpdate: [coordinatedCutover({ transform: (d) => ({ id: d['id'], amount: { gross: d['total'] } }) })],
    })
    await v._drainPendingSchemaWrites()

    // The direct write refuses…
    await expect(invoices.put('i1', { id: 'i1', amount: { gross: 5 } })).rejects.toBeInstanceOf(SchemaFenceError)
    const before = await dump(store, ['invoices', 'payments'])
    calls.length = 0

    // …and so does an otherwise-eligible atomic batch, with the SAME error.
    await expect(
      db.transaction((tx) => {
        tx.vault('acme').collection('invoices').put('i1', { id: 'i1', amount: { gross: 5 } })
        tx.vault('acme').collection<Invoice>('payments').put('pay-1', { amount: 5, status: 'paid' })
      }),
    ).rejects.toBeInstanceOf(SchemaFenceError)

    expect(calls.filter(c => c.startsWith('tx:'))).toEqual([]) // refused before the batch
    expect(bodyWrites(calls)).toEqual([])
    expect(await dump(store, ['invoices', 'payments'])).toBe(before)
  })

  it('a stale-generation client refuses an atomic batch with MigrationRequiredError', async () => {
    const { store, calls } = instrument()
    const seed = await createNoydb({ store, user: 'owner', secret: SECRET })
    const v0 = await seed.openVault('acme')
    v0.collection('invoices', { schema: oldSchema, persistJsonSchema: true })
    await v0._drainPendingSchemaWrites()

    // A client that opened at generation 0…
    const stale = await createNoydb({ store, user: 'owner', secret: SECRET, transactionsStrategy: withTransactions() })
    const staleVault = await stale.openVault('acme')
    staleVault.collection('invoices', { schema: oldSchema, persistJsonSchema: true })
    await staleVault._drainPendingSchemaWrites()

    // …while another client cuts over and bumps the generation.
    const mig = await createNoydb({ store, user: 'owner', secret: SECRET })
    const migVault = await mig.openVault('acme')
    migVault.collection('invoices', {
      schema: newSchema, persistJsonSchema: true,
      schemaUpdate: [coordinatedCutover({ transform: (d) => ({ id: d['id'], amount: { gross: d['total'] } }) })],
    })
    await migVault._drainPendingSchemaWrites()
    await migVault.runSchemaCutover()
    calls.length = 0

    await expect(
      stale.transaction((tx) => {
        tx.vault('acme').collection('invoices').put('i9', { id: 'i9', total: 1 })
      }),
    ).rejects.toBeInstanceOf(MigrationRequiredError)

    expect(calls.filter(c => c.startsWith('tx:'))).toEqual([])
  })
})

/**
 * The delete leg.
 *
 * #922 — `_txAtomicSafe('delete')` now consults the enforcer's
 * `_deleteCascadesPossible(name)` (Vault unions the THREE cascade sources
 * `enforceRefsOnDelete` fires from: lookup-ref edges, classic inbound refs,
 * managed links), so a refs-free collection's delete-inclusive batch takes
 * the atomic path on a REAL vault — no spy needed. A collection any source
 * touches still refuses (asserted here per source in
 * `atomic-eligibility.test.ts`), because `_prepareDelete` runs those
 * cascades DURING prepare, which is not abortable.
 */
describe('#906/#922 — the delete leg of a mixed batch', () => {
  it('a refs-bearing collection still refuses a delete-inclusive batch (OCC path)', async () => {
    const { store, calls } = instrument()
    const db = await open(store)
    const v = db.vault('acme')
    v.collection('clients')
    v.collection('invoices', { refs: { clientId: ref('clients') } })
    await v.collection<Record<string, unknown>>('clients').put('c-1', { name: 'n' })
    calls.length = 0

    await db.transaction((tx) => {
      const clients = tx.vault('acme').collection<Record<string, unknown>>('clients')
      clients.put('c-2', { name: 'm' })
      clients.delete('c-1') // clients is an inbound-ref target
    })

    expect(calls.filter(c => c.startsWith('tx:'))).toEqual([]) // OCC path
  })

  it('unsynced: the delete reaches tx() as a delete-type leg alongside the put', async () => {
    const { store, calls, batches } = instrument()
    const db = await open(store)
    await db.vault('acme').collection<Invoice>('invoices').put('inv-1', { amount: 50, status: 'draft' })
    calls.length = 0

    await db.transaction((tx) => {
      const inv = tx.vault('acme').collection<Invoice>('invoices')
      inv.put('inv-2', { amount: 200, status: 'paid' })
      inv.delete('inv-1')
    })

    expect(batches[0]!.map(o => `${o.type}:${o.id}@${o.expectedVersion}`)).toEqual([
      'put:inv-2@0',
      'delete:inv-1@1',
    ])
    expect(batches[0]![1]!.envelope).toBeUndefined() // no marker without sync
    expect(bodyWrites(calls)).toEqual([])
    expect(await db.vault('acme').collection<Invoice>('invoices').get('inv-1')).toBeNull()
    expect(await db.vault('acme').collection<Invoice>('invoices').get('inv-2')).toEqual({ amount: 200, status: 'paid' })
  })

  it('synced: the delete reaches tx() as a PUT-type leg carrying the #589 marker', async () => {
    const { store, calls, batches } = instrument()
    const db = await open(store, { sync: toMemory(), syncStrategy: withSync() })
    await db.vault('acme').collection<Invoice>('invoices').put('inv-1', { amount: 50, status: 'draft' })
    calls.length = 0

    await db.transaction((tx) => {
      const inv = tx.vault('acme').collection<Invoice>('invoices')
      inv.put('inv-2', { amount: 200, status: 'paid' })
      inv.delete('inv-1')
    })

    const legs = batches[0]!
    expect(legs.map(o => `${o.type}:${o.id}@${o.expectedVersion}`)).toEqual([
      'put:inv-2@0',
      'put:inv-1@1', // the marker rides as an ordinary put at live._v + 1
    ])
    expect(legs[1]!.envelope?._del).toBe(true)
    expect(legs[1]!.envelope?._v).toBe(2)
    expect(bodyWrites(calls)).toEqual([])
    expect(await db.vault('acme').collection<Invoice>('invoices').get('inv-1')).toBeNull()
  })
})
