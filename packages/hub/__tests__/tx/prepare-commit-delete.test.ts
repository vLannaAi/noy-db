/**
 * #905 — `Collection._doDelete` split into `_prepareDelete` / `_commitDelete`.
 *
 * The prepare half runs every refusal (permission, tier, gate bus, refs),
 * resolves the prior version and MINTS the #589 delete marker — and commits
 * nothing: no store write, no history entry, no ledger append, no cache/index
 * mutation, no event, no `markerIds` entry. `null` is the "nothing to delete"
 * answer that today's early `return false` paths gave.
 *
 * The commit half is the only thing that makes the delete observable, and
 * `_finalizeDelete` is commit minus the store write — the entry point the
 * atomic (`store.tx()`) path uses once the marker/removal is already persisted.
 *
 * A deliberately separate split from the put pair (#842c): delete differs in
 * hydration, the history-read gate and the #589 marker rules.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { toMemory } from '../../../to-memory/src/index.js'
import { createNoydb } from '../../src/index.js'
import { withSync } from '../../src/with-sync/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { isDeleteMarker } from '../../src/kernel/enclave/record-keys/tombstone.js'
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

/** Body-level write log — history snapshots land in their own collection. */
function tracked(): { store: NoydbStore; puts: string[]; deletes: string[] } {
  const memory = toMemory()
  const puts: string[] = []
  const deletes: string[] = []
  const store: NoydbStore = {
    ...memory,
    async put(v, c, id, env, expected) {
      if (c === 'docs') puts.push(id)
      return memory.put(v, c, id, env, expected)
    },
    async delete(v, c, id) {
      if (c === 'docs') deletes.push(id)
      return memory.delete(v, c, id)
    },
  }
  return { store, puts, deletes }
}

describe('#905 — _prepareDelete / _commitDelete split (synced: marker path)', () => {
  let db: Noydb
  let coll: Collection<Doc>
  let puts: string[]
  let deletes: string[]

  beforeEach(async () => {
    const t = tracked()
    puts = t.puts
    deletes = t.deletes
    db = await createNoydb({
      store: t.store,
      sync: toMemory(),
      user: 'owner',
      secret: 'prepare-commit-delete-secret-2026',
      syncStrategy: withSync(),
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('v')
    coll = vault.collection<Doc>('docs')
  })

  it('prepare-without-commit leaves store, cache, history and event stream untouched', async () => {
    await coll.put('a', { n: 1 })
    const events: unknown[] = []
    coll.subscribe(e => events.push(e))
    const before = JSON.stringify(await db._store.get('v', 'docs', 'a'))
    puts.length = 0
    deletes.length = 0

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prepared = await (coll as any)._prepareDelete('a', false)
    await flushMicrotasks()

    expect(prepared).not.toBeNull()
    expect(prepared.marker).toBeDefined()            // sync is on ⇒ delete is a marker put
    expect(isDeleteMarker(prepared.marker)).toBe(true)
    expect(puts).toEqual([])                          // no marker written
    expect(deletes).toEqual([])                       // …and no physical removal either
    expect(JSON.stringify(await db._store.get('v', 'docs', 'a'))).toBe(before)
    expect(await coll.get('a')).toEqual({ n: 1 })     // still live to a reader
    expect((await coll.history('a')).length).toBe(0)  // no history entry
    expect(events.length).toBe(0)                     // no events
  })

  it('prepare → commit behaves identically to a single delete (marker version, history, events)', async () => {
    await coll.put('a', { n: 1 })
    const events: unknown[] = []
    coll.subscribe(e => events.push(e))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prepared = await (coll as any)._prepareDelete('a', false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (coll as any)._commitDelete(prepared)
    await flushMicrotasks()

    expect(result).toBe(true)
    expect(await coll.get('a')).toBeNull()
    const env = await db._store.get('v', 'docs', 'a')
    expect(isDeleteMarker(env!)).toBe(true)
    expect(env?._v).toBe(2)                            // minted at live._v + 1, exactly as today
    const hist = await coll.history('a')
    expect(hist.length).toBe(1)                        // the v1 snapshot, same as a plain delete()
    expect(hist[0]!.record).toEqual({ n: 1 })
    expect(events).toEqual([{ type: 'delete', id: 'a', record: null }])
  })

  it('_finalizeDelete runs the commit tail WITHOUT writing the marker', async () => {
    await coll.put('b', { n: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prepared = await (coll as any)._prepareDelete('b', false)
    // Stand in for `store.tx()` having already persisted the marker.
    await db._store.put('v', 'docs', 'b', prepared.marker)
    puts.length = 0
    deletes.length = 0

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (coll as any)._finalizeDelete(prepared)).toBe(true)

    expect(puts).toEqual([])                           // the marker was NOT re-written
    expect(deletes).toEqual([])
    expect(await coll.get('b')).toBeNull()             // …but the tail still ran
    expect((await coll.history('b')).length).toBe(1)
  })

  it('prepare returns null for a missing record, matching todays early `return false`', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (coll as any)._prepareDelete('ghost', false)).toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await coll.delete('ghost')).toBeUndefined()
  })

  it('prepare returns null for an id that is already a delete marker', async () => {
    await coll.put('c', { n: 1 })
    await coll.delete('c')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (coll as any)._prepareDelete('c', false)).toBeNull()
  })

  it('a single delete() still goes through prepare + commit with unchanged semantics', async () => {
    await coll.put('d', { n: 1 })
    await coll.delete('d')

    expect(await coll.get('d')).toBeNull()
    const env = await db._store.get('v', 'docs', 'd')
    expect(isDeleteMarker(env!)).toBe(true)
    expect(env?._v).toBe(2)
  })
})

describe('#905 — _prepareDelete / _commitDelete split (unsynced: physical-removal path)', () => {
  let db: Noydb
  let coll: Collection<Doc>
  let deletes: string[]

  beforeEach(async () => {
    const t = tracked()
    deletes = t.deletes
    db = await createNoydb({
      store: t.store,
      user: 'owner',
      secret: 'prepare-commit-delete-secret-2026',
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('v')
    coll = vault.collection<Doc>('docs')
  })

  it('mints no marker and commits a plain adapter.delete', async () => {
    await coll.put('a', { n: 1 })
    deletes.length = 0

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prepared = await (coll as any)._prepareDelete('a', false)
    expect(prepared.marker).toBeUndefined()  // no sync ⇒ physical removal
    expect(deletes).toEqual([])              // prepare removed nothing

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (coll as any)._commitDelete(prepared)).toBe(true)
    expect(deletes).toEqual(['a'])
    expect(await db._store.get('v', 'docs', 'a')).toBeNull()
    expect(await coll.get('a')).toBeNull()
    expect((await coll.history('a')).length).toBe(1)
  })

  it('_finalizeDelete skips the removal but still runs the tail', async () => {
    await coll.put('b', { n: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prepared = await (coll as any)._prepareDelete('b', false)
    await db._store.delete('v', 'docs', 'b') // stand in for the `store.tx()` leg
    deletes.length = 0

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (coll as any)._finalizeDelete(prepared)).toBe(true)

    expect(deletes).toEqual([])
    expect(await coll.get('b')).toBeNull()
    expect((await coll.history('b')).length).toBe(1)
  })
})
