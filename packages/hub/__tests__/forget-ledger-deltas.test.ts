/**
 * #734 — vault.forget() purges the forgotten record's plaintext
 * `_ledger_deltas` rows (the erasure twin of #729's elevate-side purge).
 *
 * Coverage:
 *   - forget() deletes the subject record's delta rows, keeps the
 *     tamper-chain valid, leaves a sibling record's deltas intact, and
 *     reports the count in ForgetResult.ledgerDeltasPurged
 *   - forget() without a history strategy fails FAST — nothing shredded
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { paddedIndex } from '../src/with-commit/history/ledger/entry.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'

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

interface Doc { id: string; body: string; buyerId: string }

describe('vault.forget() purges _ledger_deltas (#734)', () => {
  it('deletes the forgotten record’s delta rows, keeps verify() ok, leaves siblings intact', async () => {
    const adapter = memory()
    const db = await createNoydb({
      store: adapter,
      user: 'alice', historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { docs: 'buyerId' } }),
      secret: 'test-secret-1234',
    })
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs')
    const ledger = company.ledger()

    // 'a' (subject B-1) updated twice → delta rows; 'b' (B-2) too — must survive.
    await docs.put('a', { id: 'a', body: 'a-v1', buyerId: 'B-1' })
    await docs.put('a', { id: 'a', body: 'a-v2', buyerId: 'B-1' })
    await docs.put('b', { id: 'b', body: 'b-v1', buyerId: 'B-2' })
    await docs.put('b', { id: 'b', body: 'b-v2', buyerId: 'B-2' })

    const entries = await ledger.entries()
    const aDeltaEntry = entries.find((e) => e.collection === 'docs' && e.id === 'a' && e.deltaHash !== undefined)
    const bDeltaEntry = entries.find((e) => e.collection === 'docs' && e.id === 'b' && e.deltaHash !== undefined)
    expect(aDeltaEntry).toBeDefined()
    expect(bDeltaEntry).toBeDefined()
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(aDeltaEntry!.index))).not.toBeNull()

    const result = await company.forget('B-1')

    // THE FIX: a's plaintext delta rows are gone; b's survive; chain stays valid.
    expect(result.ledgerDeltasPurged).toBeGreaterThan(0)
    expect(result.ledgerDeltaResidue).toEqual([])
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(aDeltaEntry!.index))).toBeNull()
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(bDeltaEntry!.index))).not.toBeNull()
    expect((await ledger.verify()).ok).toBe(true)
    // The summary forget entry + a's entry metadata (audit trail) survive.
    expect((await ledger.entries()).some((e) => e.op === 'forget')).toBe(true)
    expect((await ledger.entries()).some((e) => e.id === 'a')).toBe(true)
    db.close()
  })

  it('fails FAST without a history strategy — nothing shredded', async () => {
    const adapter = memory()
    const db = await createNoydb({
      store: adapter,
      user: 'alice',
      forgetStrategy: withForgetCascade({ subjects: { docs: 'buyerId' } }),
      secret: 'test-secret-1234',
    })
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs')
    await docs.put('a', { id: 'a', body: 'a-v1', buyerId: 'B-1' })

    await expect(company.forget('B-1')).rejects.toThrow(/requires the history strategy/)
    // Fail-fast: the record was NOT tombstoned first.
    expect(await docs.get('a')).not.toBeNull()
    db.close()
  })
})
