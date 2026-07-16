/**
 * #729 — `LedgerStore.purgeRecordDeltas` deletes a record's plaintext
 * `_ledger_deltas` rows while leaving the tamper-chain valid.
 *
 * `verify()` recomputes the chain from each entry's canonical fields
 * (including the `deltaHash` field, which lives on the `_ledger`
 * entry, not on the `_ledger_deltas` row) and never re-reads
 * `_ledger_deltas` — so deleting a delta row cannot break `verify()`.
 * `reconstruct()` already treats a missing delta as a pruned stop.
 *
 * Coverage:
 *   - purges a record's delta rows, keeps the chain valid, leaves a
 *     sibling record's deltas intact, and retains the entry metadata
 *   - is idempotent — purging already-purged deltas is a no-op
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import type { Noydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { paddedIndex } from '../src/with-commit/history/ledger/entry.js'

// Inline memory adapter (same shape as other ledger test files).
function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

interface Doc {
  id: string
  body: string
}

describe('LedgerStore.purgeRecordDeltas (#729)', () => {
  let adapter: NoydbStore
  let db: Noydb

  beforeEach(async () => {
    adapter = memory()
    db = await createNoydb({
      store: adapter,
      user: 'alice', historyStrategy: withHistory(),
      secret: 'test-passphrase-1234',
    })
  })

  it('purges a record’s delta rows, keeps the chain valid, leaves siblings intact', async () => {
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs')
    const ledger = company.ledger()

    // 'a' is updated (put twice) → produces a delta on its 2nd put.
    await docs.put('a', { id: 'a', body: 'a-v1' })
    await docs.put('a', { id: 'a', body: 'a-v2' })
    // 'b' is also updated → its own delta, must survive a's purge.
    await docs.put('b', { id: 'b', body: 'b-v1' })
    await docs.put('b', { id: 'b', body: 'b-v2' })

    expect((await ledger.verify()).ok).toBe(true)

    const entries = await ledger.entries()
    const aDeltaEntry = entries.find((e) => e.collection === 'docs' && e.id === 'a' && e.deltaHash !== undefined)
    const bDeltaEntry = entries.find((e) => e.collection === 'docs' && e.id === 'b' && e.deltaHash !== undefined)
    expect(aDeltaEntry).toBeDefined()
    expect(bDeltaEntry).toBeDefined()

    // a's delta row exists at rest before the purge.
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(aDeltaEntry!.index))).not.toBeNull()

    const purged = await ledger.purgeRecordDeltas('docs', 'a')
    expect(purged).toBeGreaterThan(0)

    // a's delta row is gone; b's remains.
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(aDeltaEntry!.index))).toBeNull()
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(bDeltaEntry!.index))).not.toBeNull()

    // THE INVARIANT: the tamper-chain is untouched by the purge.
    expect((await ledger.verify()).ok).toBe(true)

    // Entry metadata (the audit record that 'a' was mutated) survives.
    expect((await ledger.entries()).some((e) => e.id === 'a')).toBe(true)
  })

  it('is idempotent — purging already-purged deltas is a no-op that keeps verify() ok', async () => {
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs')
    const ledger = company.ledger()

    await docs.put('a', { id: 'a', body: 'a-v1' })
    await docs.put('a', { id: 'a', body: 'a-v2' })

    const first = await ledger.purgeRecordDeltas('docs', 'a')
    expect(first).toBeGreaterThan(0)

    const second = await ledger.purgeRecordDeltas('docs', 'a')
    expect(second).toBe(0)

    expect((await ledger.verify()).ok).toBe(true)
  })
})
