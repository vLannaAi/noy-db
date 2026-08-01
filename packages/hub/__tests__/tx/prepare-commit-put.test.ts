/**
 * #904 — `Collection._putInternal` split into `_preparePut` / `_commitPut`.
 *
 * The prepare half produces the encrypted envelope and NOTHING else: no store
 * write, no cache/index mutation, no history entry, no ledger append, no event.
 * The commit half is the only thing that makes a write observable. Together
 * they must be indistinguishable from today's single `put()`.
 *
 * `_finalizePut` is commit minus the `adapter.put` — the entry point the
 * atomic (`store.tx()`) path uses once the envelopes are already persisted.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { toMemory } from '../../../to-memory/src/index.js'
import { createNoydb } from '../../src/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import type { Noydb } from '../../src/index.js'
import type { Collection } from '../../src/kernel/collection.js'
import type { NoydbStore } from '../../src/kernel/types.js'

interface Doc extends Record<string, unknown> { n: number }

// The subscribe() callback hydrates the record asynchronously before firing.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('#904 — _preparePut / _commitPut split', () => {
  let db: Noydb
  let coll: Collection<Doc>
  let bodyPuts: string[]

  beforeEach(async () => {
    const memory = toMemory()
    bodyPuts = []
    // Only the record bodies matter here — history snapshots land in their own
    // collection and would otherwise mask a stray body write.
    const store: NoydbStore = {
      ...memory,
      async put(v, c, id, env, expected) {
        if (c === 'docs') bodyPuts.push(id)
        return memory.put(v, c, id, env, expected)
      },
    }
    db = await createNoydb({
      store,
      user: 'owner',
      secret: 'prepare-commit-secret-2026',
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('v')
    coll = vault.collection<Doc>('docs')
  })

  it('prepare-without-commit leaves store, cache, history and event stream untouched', async () => {
    await coll.put('seed', { n: 1 })
    const events: unknown[] = []
    coll.subscribe(e => events.push(e))
    const store = db._store
    const before = JSON.stringify(await store.get('v', 'docs', 'seed'))
    const idsBefore = JSON.stringify(await store.list('v', 'docs'))
    bodyPuts.length = 0

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prepared = await (coll as any)._preparePut('seed', { n: 2 })
    expect(prepared.envelope).toBeDefined()
    expect(prepared.version).toBe(2)
    await flushMicrotasks()

    expect(bodyPuts).toEqual([])                                             // no store write
    expect(JSON.stringify(await store.get('v', 'docs', 'seed'))).toBe(before) // store untouched
    expect(JSON.stringify(await store.list('v', 'docs'))).toBe(idsBefore)     // no new ids
    expect(await coll.get('seed')).toEqual({ n: 1 })                          // cache untouched
    expect((await coll.history('seed')).length).toBe(0)                       // no history entry
    expect(events.length).toBe(0)                                             // no events
  })

  it('prepare → commit behaves identically to a single put (_v, cache, history, events)', async () => {
    await coll.put('a', { n: 1 })
    const events: unknown[] = []
    coll.subscribe(e => events.push(e))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prepared = await (coll as any)._preparePut('a', { n: 2 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (coll as any)._commitPut(prepared)
    await flushMicrotasks()

    const env = await db._store.get('v', 'docs', 'a')
    expect(env?._v).toBe(2)
    expect(await coll.get('a')).toEqual({ n: 2 })
    const hist = await coll.history('a')
    expect(hist.length).toBe(1) // the v1 snapshot, same as a plain second put
    expect(hist[0]!.version).toBe(1)
    expect(hist[0]!.record).toEqual({ n: 1 })
    expect(events).toEqual([{ type: 'put', id: 'a', record: { n: 2 } }])
  })

  it('_finalizePut runs the commit tail WITHOUT writing the record body', async () => {
    await coll.put('b', { n: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prepared = await (coll as any)._preparePut('b', { n: 2 })
    // Stand in for `store.tx()` having already persisted the envelope.
    await db._store.put('v', 'docs', 'b', prepared.envelope)
    bodyPuts.length = 0

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (coll as any)._finalizePut(prepared)

    expect(bodyPuts).toEqual([])                  // the body was NOT re-written
    expect(await coll.get('b')).toEqual({ n: 2 }) // …but the tail still ran
    expect((await coll.history('b')).length).toBe(1)
  })

  it('a single put() still goes through prepare + commit with unchanged semantics', async () => {
    await coll.put('c', { n: 1 })
    await coll.put('c', { n: 2 })
    await coll.put('c', { n: 3 })

    expect(await coll.get('c')).toEqual({ n: 3 })
    expect((await db._store.get('v', 'docs', 'c'))?._v).toBe(3)
    const hist = await coll.history('c')
    expect(hist.map(h => h.version)).toEqual([2, 1])
  })
})
