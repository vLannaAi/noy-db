/**
 * #921 — `putMany({ atomic: true })` delegates through ONE `store.tx()`
 * batch on a `txAtomic` store: the second consumer of the #904/#905
 * prepare/commit seam, same shape as #906's atomic branch in
 * `runTransaction`.
 *
 * Gate (single-collection puts-only, so `canCommitAtomically` reduces
 * to): store declares `txAtomic` AND implements `tx()`, no duplicate id
 * in the batch, `_txAtomicSafe('put')` on the one collection. Anything
 * else keeps the sequential Phase-1/Phase-2 loop byte-for-byte.
 *
 * Failure semantics mirror #906: a `tx()` throw means the store applied
 * NOTHING — rethrow without revert; a finalize throw walks the existing
 * revert path. Ordering change ships with it: history/ledger/events fire
 * post-commit on the atomic path.
 */
import { describe, it, expect, vi } from 'vitest'
import { toMemory } from '../../../to-memory/src/index.js'
import { ConflictError, createNoydb } from '../../src/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import type { Noydb } from '../../src/index.js'
import type { Collection } from '../../src/kernel/collection.js'
import type { NoydbStore, TxOp } from '../../src/kernel/types.js'

const SECRET = 'put-many-atomic-test-secret-2026'

interface Invoice extends Record<string, unknown> { amount: number; status: string }

interface Instrumented {
  store: NoydbStore
  /** Every store write, in order: `tx:<n>`, `put:<coll>/<id>`, `delete:<coll>/<id>`. */
  calls: string[]
  batches: TxOp[][]
}

/** Same observability idiom as `atomic-commit.test.ts`. */
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

const bodyWrites = (calls: string[]): string[] =>
  calls.filter(c => !c.startsWith('tx:') && !c.includes(':_'))

async function open(store: NoydbStore, extra: Record<string, unknown> = {}): Promise<Noydb> {
  const db = await createNoydb({ store, user: 'owner', secret: SECRET, ...extra })
  await db.openVault('acme')
  return db
}

describe('#921 — putMany atomic mode delegates through store.tx()', () => {
  it('an eligible batch submits exactly ONE tx() call — no per-op store writes', async () => {
    const { store, calls, batches } = instrument()
    const db = await open(store)
    const invoices = db.vault('acme').collection<Invoice>('invoices')
    calls.length = 0

    const result = await invoices.putMany(
      [
        ['inv-1', { amount: 100, status: 'draft' }],
        ['inv-2', { amount: 200, status: 'draft' }],
      ],
      { atomic: true },
    )

    expect(result).toEqual({ ok: true, success: ['inv-1', 'inv-2'], failures: [] })
    expect(calls.filter(c => c.startsWith('tx:'))).toEqual(['tx:2'])
    expect(bodyWrites(calls)).toEqual([])
    expect(batches[0]!.map(o => `${o.type}:${o.collection}/${o.id}@${o.expectedVersion}`)).toEqual([
      'put:invoices/inv-1@0',
      'put:invoices/inv-2@0',
    ])
    expect(await invoices.get('inv-1')).toEqual({ amount: 100, status: 'draft' })
    expect(await invoices.get('inv-2')).toEqual({ amount: 200, status: 'draft' })
  })

  it('per-item expectedVersion still pre-flights — a mismatch refuses BEFORE the store sees anything', async () => {
    const { store, calls } = instrument()
    const db = await open(store)
    const invoices = db.vault('acme').collection<Invoice>('invoices')
    await invoices.put('inv-1', { amount: 100, status: 'draft' })
    calls.length = 0

    await expect(
      invoices.putMany(
        [
          ['inv-1', { amount: 999, status: 'paid' }, { expectedVersion: 42 }],
          ['inv-2', { amount: 200, status: 'draft' }],
        ],
        { atomic: true },
      ),
    ).rejects.toBeInstanceOf(ConflictError)

    expect(calls.filter(c => c.startsWith('tx:'))).toEqual([])
    expect(bodyWrites(calls)).toEqual([])
    expect(await invoices.get('inv-1')).toEqual({ amount: 100, status: 'draft' })
    expect(await invoices.get('inv-2')).toBeNull()
  })

  it('a concurrent writer inside the prepare→commit window fails the batch with ConflictError, nothing applied', async () => {
    const memory = toMemory()
    let raced = false
    const { store, calls } = instrument(memory, {
      beforeTx: async () => {
        if (raced) return
        raced = true
        const live = (await memory.get('acme', 'invoices', 'inv-1'))!
        await memory.put('acme', 'invoices', 'inv-1', { ...live, _v: live._v + 1 })
      },
    })
    const db = await open(store)
    const invoices = db.vault('acme').collection<Invoice>('invoices')
    await invoices.put('inv-1', { amount: 50, status: 'draft' })
    calls.length = 0

    const err: unknown = await invoices.putMany(
      [
        ['inv-1', { amount: 100, status: 'paid' }],
        ['inv-2', { amount: 200, status: 'paid' }],
      ],
      { atomic: true },
    ).then(() => null, (e: unknown) => e)

    // Store-thrown, surfaces unwrapped; matched by name — `to-memory` binds
    // the published `@noy-db/hub/to` seam (different class identity).
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).constructor.name).toBe(ConflictError.name)
    // Nothing applied, and NO revert pass ran (nothing to unwind).
    expect(await memory.get('acme', 'invoices', 'inv-2')).toBeNull()
    expect((await memory.get('acme', 'invoices', 'inv-1'))!._v).toBe(2) // the racer's bump only
    expect(calls.filter(c => c.startsWith('tx:'))).toEqual(['tx:2'])
    expect(bodyWrites(calls)).toEqual([])
  })

  it('history, ledger and change events fire per record AFTER the batch lands, in entry order', async () => {
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
    const invoices = db.vault('acme').collection<Invoice>('invoices')
    await invoices.put('inv-1', { amount: 50, status: 'draft' })
    await invoices.put('inv-2', { amount: 60, status: 'draft' })
    db.on('change', (e) => log.push(`event:${e.id}`))
    log.length = 0

    await invoices.putMany(
      [
        ['inv-1', { amount: 100, status: 'paid' }],
        ['inv-2', { amount: 200, status: 'paid' }],
      ],
      { atomic: true },
    )

    expect(log).toEqual([
      'tx',
      'history:inv-1', 'ledger', 'event:inv-1',
      'history:inv-2', 'ledger', 'event:inv-2',
    ])
  })

  it('a finalize throw reverts the whole batch through the existing revert path', async () => {
    const { store, calls } = instrument()
    const db = await open(store)
    const invoices = db.vault('acme').collection<Invoice>('invoices')
    await invoices.put('inv-1', { amount: 50, status: 'draft' })

    const boom = new Error('finalize exploded')
    const realFinalize = invoices._finalizePut.bind(invoices)
    let n = 0
    vi.spyOn(invoices as Collection<Invoice>, '_finalizePut').mockImplementation(async (prepared) => {
      if (++n === 2) throw boom
      return realFinalize(prepared)
    })
    calls.length = 0

    await expect(
      invoices.putMany(
        [
          ['inv-1', { amount: 100, status: 'paid' }],
          ['inv-2', { amount: 200, status: 'paid' }],
        ],
        { atomic: true },
      ),
    ).rejects.toBe(boom)

    // The bytes were durable when finalize blew up, so the revert path ran:
    // one tx() for the commit, then a second for the revert itself (#886
    // sends the whole revert as one batch on a txAtomic store), and reads
    // see pre-batch state again.
    expect(calls.filter(c => c.startsWith('tx:'))).toEqual(['tx:2', 'tx:2'])
    expect(await invoices.get('inv-1')).toEqual({ amount: 50, status: 'draft' })
    expect(await invoices.get('inv-2')).toBeNull()
  })

  it('duplicate ids in the batch fall back to the sequential path', async () => {
    const { store, calls } = instrument()
    const db = await open(store)
    const invoices = db.vault('acme').collection<Invoice>('invoices')
    calls.length = 0

    const result = await invoices.putMany(
      [
        ['inv-1', { amount: 100, status: 'draft' }],
        ['inv-1', { amount: 150, status: 'paid' }],
      ],
      { atomic: true },
    )

    expect(result.ok).toBe(true)
    expect(calls.filter(c => c.startsWith('tx:'))).toEqual([])
    expect(bodyWrites(calls)).toEqual(['put:invoices/inv-1', 'put:invoices/inv-1'])
    expect(await invoices.get('inv-1')).toEqual({ amount: 150, status: 'paid' })
  })

  it('a store without txAtomic keeps the sequential path byte-for-byte', async () => {
    const memory = toMemory()
    const occ: NoydbStore = {
      ...memory,
      capabilities: { ...memory.capabilities!, txAtomic: false },
    }
    const { store, calls } = instrument(occ)
    const db = await open(store)
    const invoices = db.vault('acme').collection<Invoice>('invoices')
    calls.length = 0

    await invoices.putMany(
      [
        ['inv-1', { amount: 100, status: 'draft' }],
        ['inv-2', { amount: 200, status: 'draft' }],
      ],
      { atomic: true },
    )

    expect(calls.filter(c => c.startsWith('tx:'))).toEqual([])
    expect(bodyWrites(calls)).toEqual(['put:invoices/inv-1', 'put:invoices/inv-2'])
  })

  it('an onBeforeWrite hook keeps the batch on the sequential path, and still fires per op (#931)', async () => {
    const { store, calls } = instrument()
    const db = await open(store)
    const invoices = db.vault('acme').collection<Invoice>('invoices')
    const seen: string[] = []
    db.onBeforeWrite((e) => { seen.push(e.docId) })
    calls.length = 0

    await invoices.putMany(
      [
        ['inv-1', { amount: 100, status: 'draft' }],
        ['inv-2', { amount: 200, status: 'draft' }],
      ],
      { atomic: true },
    )

    expect(calls.filter(c => c.startsWith('tx:'))).toEqual([])
    expect(seen).toEqual(['inv-1', 'inv-2'])
  })

  it('an onAfterWrite hook no longer gates — the batch delegates and the hook fires per record after the batch lands (#931)', async () => {
    const log: string[] = []
    const memory = toMemory()
    const store: NoydbStore = {
      ...memory,
      async tx(ops) {
        const out = await memory.tx!(ops)
        log.push('tx')
        return out
      },
    }
    const db = await open(store)
    const invoices = db.vault('acme').collection<Invoice>('invoices')
    db.onAfterWrite((e) => { log.push(`after:${e.docId}:${e.op}`) })
    log.length = 0

    await invoices.putMany(
      [
        ['inv-1', { amount: 100, status: 'draft' }],
        ['inv-2', { amount: 200, status: 'draft' }],
      ],
      { atomic: true },
    )

    expect(log).toEqual(['tx', 'after:inv-1:create', 'after:inv-2:create'])
  })
})
