/**
 * LedgerEntry amendment-op coverage.
 *
 * Two layers:
 *
 *   1. Type-shape sanity — confirms the discriminated union accepts an
 *      `op: 'amendment'` entry with the structured `amendment` payload.
 *   2. Runtime regression — confirms `vault.verifyBackupIntegrity()`
 *      does NOT trip a false data-envelope check when the ledger
 *      carries an amendment entry. The bug being pinned here: an
 *      amendment entry has empty `collection` and `id`, so naive
 *      iteration would build a `"/"` key and then try to fetch a
 *      record at `('', '')` that doesn't exist, returning
 *      `{ ok: false, kind: 'data' }`. Amendment entries must be
 *      filtered out of the data cross-check.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { ConflictError } from '../../src/kernel/errors.js'
import type { LedgerEntry } from '../../src/with-commit/history/ledger/entry.js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
} from '../../src/kernel/types.js'

function toMemory(): NoydbStore {
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
        s[n] = {}
        for (const [id, env] of coll) s[n]![id] = env
      }
      return s
    },
    async saveAll(c, data) {
      store.delete(c)
      for (const [col, ids] of Object.entries(data)) {
        for (const [id, env] of Object.entries(ids)) {
          getCollection(c, col).set(id, env)
        }
      }
    },
  }
}

describe('LedgerEntry amendment op', () => {
  it('accepts an amendment entry shape', () => {
    const entry: LedgerEntry = {
      index: 5,
      prevHash: 'abc',
      op: 'amendment',
      collection: '',
      id: '',
      version: 0,
      ts: '2026-05-18T00:00:00.000Z',
      actor: 'alice',
      payloadHash: 'hash',
      amendment: {
        reason: 'correct split',
        role: 'admin',
        changes: [
          { collection: 'lines', id: 'l1', vBefore: 2, vAfter: 3 },
          { collection: 'lines', id: 'l2', vBefore: 1, vAfter: 2 },
        ],
        invariantsPassed: ['lines'],
      },
    }
    expect(entry.op).toBe('amendment')
    expect(entry.amendment?.changes).toHaveLength(2)
  })

  it('verifyBackupIntegrity() ignores amendment entries (no false data failure)', async () => {
    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'pass',
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('firm')

    // Seed one normal record so we have a put entry in the ledger,
    // then append a synthetic amendment entry. Without the fix the
    // amendment entry's empty (collection, id) would synthesize a
    // `"/"` key in the data cross-check and trip a false failure.
    const invoices = vault.collection<{ amount: number }>('invoices')
    await invoices.put('inv-1', { amount: 100 })

    await vault.ledger().append({
      op: 'amendment',
      collection: '',
      id: '',
      version: 0,
      actor: 'alice',
      payloadHash: 'amendment-hash',
      amendment: {
        reason: 'correct split',
        role: 'admin',
        changes: [
          { collection: 'invoices', id: 'inv-1', vBefore: 1, vAfter: 1 },
        ],
        invariantsPassed: ['invoices'],
      },
    })

    const result = await vault.verifyBackupIntegrity()
    expect(result.ok).toBe(true)

    db.close()
  })
})
