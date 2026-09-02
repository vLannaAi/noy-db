/**
 * Concurrent-transaction simulation (#920 scope addition).
 *
 * Two REAL `Noydb` instances — separate caches, separate write queues —
 * share one `memoryStore({ full: true })` store and race atomic batches through the #906
 * forward-commit path (`db.transaction(fn)` → one `store.tx()` on a
 * `txAtomic` store). The store-side CAS (`TxOp.expectedVersion`) is the
 * only thing closing the pre-flight→commit window, so these scenarios
 * assert the guarantee end to end, with no hub internals mocked: writers
 * are hub instances, the store is the real `toMemory`, and interleavings
 * are forced only by gating WHEN a submitted batch reaches the store.
 *
 * What is asserted is the store-contract promise, no more: a batch that
 * lost the race fails with `ConflictError` and applies NOTHING (pair
 * consistency); disjoint batches all land. Cross-instance convergence
 * after a conflict is the sync engine's job, not `transaction()`'s, and
 * is deliberately not asserted here.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../../packages/hub/src/index.js'
import { withTransactions } from '../../../packages/hub/src/with-commit/tx/index.js'
import { memoryStore } from '@noy-db/hub'
import type { Noydb } from '../../../packages/hub/src/index.js'
import type { NoydbStore } from '../../../packages/hub/src/kernel/types.js'

const SECRET = 'simulation-concurrent-secret-2026'

interface Doc extends Record<string, unknown> { writer: string; round: number }

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/**
 * Hand an instance a view of the shared store whose `tx()` signals when a
 * batch has been SUBMITTED (i.e. the hub has finished preparing) and only
 * forwards it once `gate` opens. Everything else passes straight through.
 */
function gatedView(
  shared: NoydbStore,
  gate: Promise<void>,
  onSubmit: () => void,
): NoydbStore {
  return {
    ...shared,
    async tx(ops) {
      onSubmit()
      await gate
      return shared.tx!(ops)
    },
  }
}

async function openWriter(store: NoydbStore): Promise<Noydb> {
  const db = await createNoydb({
    store,
    user: 'owner',
    secret: SECRET,
    transactionsStrategy: withTransactions(),
  })
  await db.openVault('acme')
  return db
}

describe('simulation: two writers racing an atomic batch on a txAtomic store', () => {
  it('a plain writer landing inside the pre-flight→commit window fails the whole batch', async () => {
    const shared = memoryStore({ full: true })
    const submitted = deferred()
    const gate = deferred()
    const writerA = await openWriter(gatedView(shared, gate.promise, submitted.resolve))

    // Seed through A BEFORE opening B: an instance snapshots the vault
    // keyring at openVault(), so B must open after the collection DEK was
    // minted to decrypt A's records (keyring refresh is sync's job).
    await writerA.vault('acme').collection<Doc>('accounts').put('acct', { writer: 'seed', round: 0 })
    const writerB = await openWriter(shared)
    // Warm B's cache so B's own OCC put carries the right prior version.
    expect(await writerB.vault('acme').collection<Doc>('accounts').get('acct')).toEqual({ writer: 'seed', round: 0 })

    // A stages a two-leg batch; its tx() parks at the gate after prepare.
    const outcome = writerA.transaction((tx) => {
      const accounts = tx.vault('acme').collection<Doc>('accounts')
      accounts.put('acct', { writer: 'A', round: 1 })
      accounts.put('other', { writer: 'A', round: 1 })
    }).then(() => null, (e: unknown) => e)

    // Once A's batch is in flight, B commits an ordinary put to the same
    // record — the exact concurrent writer #906's CAS exists to catch.
    await submitted.promise
    await writerB.vault('acme').collection<Doc>('accounts').put('acct', { writer: 'B', round: 1 })
    gate.resolve()

    const err = await outcome
    // Store-thrown error: matched by name — `to-memory` binds the published
    // `@noy-db/hub/to` seam, a different class identity from this import.
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).constructor.name).toBe('ConflictError')

    // All-or-nothing: B's write stands, and NEITHER of A's legs landed.
    expect(await writerB.vault('acme').collection<Doc>('accounts').get('acct')).toEqual({ writer: 'B', round: 1 })
    expect((await shared.get('acme', 'accounts', 'acct'))!._v).toBe(2) // seed + B, no A
    expect(await shared.get('acme', 'accounts', 'other')).toBeNull()
  })

  it('two symmetric batches over the same pair: exactly one lands, the loser applies nothing', async () => {
    const shared = memoryStore({ full: true })
    const submittedA = deferred()
    const submittedB = deferred()
    const gateA = deferred()
    const gateB = deferred()
    const writerA = await openWriter(gatedView(shared, gateA.promise, submittedA.resolve))

    // Seed the pair through A before opening B (keyring snapshot — see the
    // first scenario), then warm B's cache to the same base versions.
    const seedA = writerA.vault('acme').collection<Doc>('accounts')
    await seedA.put('left', { writer: 'seed', round: 0 })
    await seedA.put('right', { writer: 'seed', round: 0 })
    const writerB = await openWriter(gatedView(shared, gateB.promise, submittedB.resolve))
    const viewB = writerB.vault('acme').collection<Doc>('accounts')
    await viewB.get('left')
    await viewB.get('right')

    // Both stage the SAME pair from the same base — both prepare before
    // either commits, then the batches reach the store in order A, B.
    const run = (db: Noydb, writer: string) =>
      db.transaction((tx) => {
        const accounts = tx.vault('acme').collection<Doc>('accounts')
        accounts.put('left', { writer, round: 1 })
        accounts.put('right', { writer, round: 1 })
      }).then(() => null, (e: unknown) => e)
    const outcomeA = run(writerA, 'A')
    const outcomeB = run(writerB, 'B')
    await Promise.all([submittedA.promise, submittedB.promise])
    gateA.resolve()
    const errA = await outcomeA
    gateB.resolve()
    const errB = await outcomeB

    // A won the ordering; B's whole batch must have died on the CAS.
    expect(errA).toBeNull()
    expect(errB).toBeInstanceOf(Error)
    expect((errB as Error).constructor.name).toBe('ConflictError')

    // Pair consistency: both records carry the winner's round, one version
    // bump each — a partial application would leave a mixed pair or v3.
    expect(await writerA.vault('acme').collection<Doc>('accounts').get('left')).toEqual({ writer: 'A', round: 1 })
    expect(await writerA.vault('acme').collection<Doc>('accounts').get('right')).toEqual({ writer: 'A', round: 1 })
    expect((await shared.get('acme', 'accounts', 'left'))!._v).toBe(2)
    expect((await shared.get('acme', 'accounts', 'right'))!._v).toBe(2)
  })

  it('disjoint batches from both writers land concurrently, one tx() each', async () => {
    const shared = memoryStore({ full: true })
    const txCalls: string[] = []
    const counting: NoydbStore = {
      ...shared,
      async tx(ops) {
        txCalls.push(ops.map((o) => o.id).join('+'))
        return shared.tx!(ops)
      },
    }
    const writerA = await openWriter(counting)
    const writerB = await openWriter(counting)

    await Promise.all([
      writerA.transaction((tx) => {
        const accounts = tx.vault('acme').collection<Doc>('accounts')
        accounts.put('a-1', { writer: 'A', round: 1 })
        accounts.put('a-2', { writer: 'A', round: 1 })
      }),
      writerB.transaction((tx) => {
        const accounts = tx.vault('acme').collection<Doc>('accounts')
        accounts.put('b-1', { writer: 'B', round: 1 })
        accounts.put('b-2', { writer: 'B', round: 1 })
      }),
    ])

    expect(txCalls.sort()).toEqual(['a-1+a-2', 'b-1+b-2'])
    for (const id of ['a-1', 'a-2', 'b-1', 'b-2']) {
      expect((await shared.get('acme', 'accounts', id))!._v).toBe(1)
    }
  })
})
