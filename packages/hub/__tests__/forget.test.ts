/**
 * withForgetCascade / vault.forget() — GDPR crypto-shred (#304, epic step 2).
 *
 * Spec: docs/superpowers/specs/2026-06-08-forget-cascade-design.md
 * Foundation: docs/superpowers/specs/2026-06-13-per-record-cek-foundation-design.md
 *
 * Decision pins (foundation, APPROVED): shred = TOMBSTONE (rewrite the live
 * envelope + every history version to `{_noydb,_v,_ts,_by,_iv:'',_data:''}`),
 * NOT a CEK-only delete; read of a tombstone returns null (no TamperedError).
 *
 * 9 groups:
 *  1. forget tombstones the live record + all history of matching records,
 *     leaves OTHER subjects' records intact.
 *  2. ledger.verify() still ok after shred + head op==='forget' +
 *     payloadHash === sha256Hex(subject).
 *  3. `_det` stripped → findByDet returns null (NO TamperedError) after shred.
 *  4. un-migrated (perRecordKeys:false) record reported in unmigratedRecords
 *     and still tombstoned.
 *  5. blob residue reported.
 *  6. idempotent (second forget → 0 shredded, no throw).
 *  7. rebuildSubjectIndex recovers an empty index.
 *  8. ForgetStrategyNotConfiguredError when no strategy.
 *  9. CRDT-mode + a tombstone does not throw, and list() over a collection
 *     containing a tombstone skips it.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { ConflictError, ForgetStrategyNotConfiguredError } from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import { withCrdt } from '../src/with-commit/crdt/index.js'
import { withSync } from '../src/with-party/sync/index.js'
import { sha256Hex } from '../src/with-commit/history/ledger/entry.js'

/** In-memory store exposing raw envelopes + a list helper for reserved cols. */
function memory(): NoydbStore & {
  raw(c: string, col: string, id: string): EncryptedEnvelope | undefined
  rawList(c: string, col: string): string[]
} {
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
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
    rawList(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
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
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

interface Invoice { id: string; buyerId: string; amount: number; memo?: string }

const SECRET = 'forget-test-passphrase-1234'

describe('forget — group 1: tombstones live + history of matching records', () => {
  it('shreds the subject and all its history, leaves other subjects intact', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
    })
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices')

    // buyer-1 has two records, one with several versions.
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 100 })
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 150 })
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 200 })
    await invoices.put('i-2', { id: 'i-2', buyerId: 'buyer-1', amount: 50 })
    // buyer-2 is untouched by the forget.
    await invoices.put('i-3', { id: 'i-3', buyerId: 'buyer-2', amount: 999 })
    await invoices.put('i-3', { id: 'i-3', buyerId: 'buyer-2', amount: 1000 })

    const result = await vault.forget('buyer-1')

    expect(result.subject).toBe('buyer-1')
    expect(result.recordsShredded).toBe(2)
    expect(result.collections).toEqual(['invoices'])
    // i-1 had 2 displaced history versions (v1, v2); i-2 had 0.
    expect(result.historyVersionsShredded).toBe(2)

    // buyer-1 records read as null (tombstone).
    expect(await invoices.get('i-1')).toBeNull()
    expect(await invoices.get('i-2')).toBeNull()

    // The live envelopes are tombstones (no _data / _cek / _det).
    const tomb = store.raw('v', 'invoices', 'i-1')!
    expect(tomb._data).toBe('')
    expect(tomb._cek).toBeUndefined()
    expect(tomb._det).toBeUndefined()
    expect(tomb._v).toBe(3) // version counter preserved

    // History versions are tombstoned too.
    for (const id of store.rawList('v', '_history').filter((k) => k.startsWith('invoices:i-1:'))) {
      expect(store.raw('v', '_history', id)!._data).toBe('')
    }

    // buyer-2 is intact.
    expect(await invoices.get('i-3')).toMatchObject({ amount: 1000 })
    const hist = await invoices.history('i-3')
    expect(hist.length).toBe(1)
    expect(hist[0]!.record).toMatchObject({ amount: 999 })
  })
})

describe('forget — group 2: ledger verify + head op + payloadHash', () => {
  it('ledger.verify() passes after shred; head is op:forget with subject hash', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
    })
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 100 })
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 200 })

    await vault.forget('buyer-1')

    const ledger = vault.ledger()
    const verify = await ledger.verify()
    expect(verify.ok).toBe(true)

    const entries = await ledger.entries()
    const head = entries[entries.length - 1]!
    expect(head.op).toBe('forget')
    expect(head.collection).toBe('')
    expect(head.id).toBe('')
    expect(head.version).toBe(0)
    expect(head.payloadHash).toBe(await sha256Hex('buyer-1'))
  })
})

describe('forget — group 3: _det stripped, findByDet returns null (no TamperedError)', () => {
  it('a deterministic field no longer matches a shredded record', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
    })
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices', {
      deterministicFields: ['buyerId'],
      acknowledgeDeterministicRisk: true,
    })
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 100 })

    // Before shred, findByDet finds it.
    expect(await invoices.findByDet('buyerId', 'buyer-1')).toMatchObject({ id: 'i-1' })

    await vault.forget('buyer-1')

    // After shred: _det stripped, so findByDet returns null and does NOT throw.
    const tomb = store.raw('v', 'invoices', 'i-1')!
    expect(tomb._det).toBeUndefined()
    await expect(invoices.findByDet('buyerId', 'buyer-1')).resolves.toBeNull()
  })
})

describe('forget — group 4: un-migrated record reported + still tombstoned', () => {
  it('reports a perRecordKeys:false legacy record in unmigratedRecords', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { legacy_invoices: 'buyerId' } }),
    })
    const vault = await db.openVault('v')
    // Force a legacy (no-CEK) body by writing through a DIFFERENT collection
    // instance that the strategy does not force — but the strategy forces
    // perRecordKeys for declared collections. To simulate an un-migrated
    // record we write the raw envelope directly: a body with _data and no _cek.
    const invoices = vault.collection<Invoice>('legacy_invoices')
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 100 })

    // Confirm the strategy forced perRecordKeys (the live env carries _cek).
    expect(store.raw('v', 'legacy_invoices', 'i-1')!._cek).toBeDefined()

    // Now overwrite the live envelope with a legacy (no-_cek) body to model an
    // un-migrated record, keeping the subject index ref intact.
    const live = store.raw('v', 'legacy_invoices', 'i-1')!
    await store.put('v', 'legacy_invoices', 'i-1', { ...live, _cek: undefined } as unknown as EncryptedEnvelope)

    const result = await vault.forget('buyer-1')
    expect(result.unmigratedRecords).toContain('legacy_invoices:i-1')
    // Still tombstoned.
    expect(store.raw('v', 'legacy_invoices', 'i-1')!._data).toBe('')
    expect(result.recordsShredded).toBe(1)
  })
})

describe('forget — group 5: blob residue reported', () => {
  it('reports a collection whose shredded record still has a blob slot', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
    })
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 100 })

    // Simulate a blob attachment slot for this record.
    await store.put('v', '_blob_slots_invoices', 'i-1', {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: 'x', _data: 'y',
    } as EncryptedEnvelope)

    const result = await vault.forget('buyer-1')
    expect(result.blobResidueCollections).toContain('invoices')
  })
})

describe('forget — group 6: idempotent', () => {
  it('a second forget shreds nothing and does not throw', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
    })
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 100 })

    const first = await vault.forget('buyer-1')
    expect(first.recordsShredded).toBe(1)

    const second = await vault.forget('buyer-1')
    expect(second.recordsShredded).toBe(0)
    expect(second.historyVersionsShredded).toBe(0)
    // The chain still verifies after two forgets.
    expect((await vault.ledger().verify()).ok).toBe(true)
  })
})

describe('forget — group 7: rebuildSubjectIndex recovers', () => {
  it('rebuilds the subject index from canonical records', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
    })
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 100 })
    await invoices.put('i-2', { id: 'i-2', buyerId: 'buyer-1', amount: 50 })
    await invoices.put('i-3', { id: 'i-3', buyerId: 'buyer-2', amount: 999 })

    // Wipe the subject index to simulate a lost/empty index.
    for (const k of store.rawList('v', '_subject_index')) {
      await store.delete('v', '_subject_index', k)
    }
    expect(store.rawList('v', '_subject_index').length).toBe(0)

    const subjects = await vault.rebuildSubjectIndex()
    expect(subjects).toBe(2) // buyer-1, buyer-2

    // forget now works again off the rebuilt index.
    const result = await vault.forget('buyer-1')
    expect(result.recordsShredded).toBe(2)
  })
})

describe('forget — group 8: ForgetStrategyNotConfiguredError', () => {
  it('throws when no forget strategy is configured', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('v')
    await expect(vault.forget('buyer-1')).rejects.toBeInstanceOf(ForgetStrategyNotConfiguredError)
  })
})

interface CrdtDoc { id: string; buyerId: string; tags: Record<string, string> }

describe('forget — group 9: CRDT-mode tombstone + list() skip do not throw', () => {
  it('a tombstone in a CRDT collection reads as null and list() skips it', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      crdtStrategy: withCrdt(),
      syncStrategy: withSync(),
      forgetStrategy: withForgetCascade({ subjects: { crdt_invoices: 'buyerId' } }),
    })
    const vault = await db.openVault('v')
    const invoices = vault.collection<CrdtDoc>('crdt_invoices', { crdt: 'lww-map' })
    await invoices.put('c-1', { id: 'c-1', buyerId: 'buyer-1', tags: { a: '1' } })
    await invoices.put('c-1', { id: 'c-1', buyerId: 'buyer-1', tags: { a: '2' } })
    await invoices.put('c-2', { id: 'c-2', buyerId: 'buyer-2', tags: { b: '1' } })

    await vault.forget('buyer-1')

    // CRDT-mode get on the tombstone returns null, no throw.
    await expect(invoices.get('c-1')).resolves.toBeNull()
    // getRaw also tolerant of the tombstone.
    await expect(invoices.getRaw('c-1')).resolves.toBeNull()

    // list() over the collection containing a tombstone does NOT throw and
    // skips the shredded record.
    const all = await invoices.list()
    expect(all.map((r) => r.id)).toEqual(['c-2'])
  })
})

describe('forget — group 10: persisted _idx side-cars are purged (#401)', () => {
  it('forget() deletes the _idx side-cars of shredded records, leaving no DEK-decryptable index residue', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
      indexStrategy: withIndexing(),
    })
    const vault = await db.openVault('v')
    // Lazy mode (prefetch:false) → durable `_idx/<field>/<recordId>` side-cars.
    const invoices = vault.collection<Invoice>('invoices', { indexes: ['buyerId'], prefetch: false, cache: { maxRecords: 100 } })

    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 100 })
    await invoices.put('i-2', { id: 'i-2', buyerId: 'buyer-1', amount: 50 })
    await invoices.put('i-3', { id: 'i-3', buyerId: 'buyer-2', amount: 999 })

    const idxIds = () => store.rawList('v', 'invoices').filter((k) => k.startsWith('_idx/'))
    // Side-cars exist for the soon-to-be-forgotten records.
    expect(idxIds().some((k) => k.endsWith('/i-1'))).toBe(true)
    expect(idxIds().some((k) => k.endsWith('/i-2'))).toBe(true)

    const result = await vault.forget('buyer-1')
    expect(result.recordsShredded).toBe(2)
    expect(result.indexPostingsPurged).toBeGreaterThanOrEqual(2)
    expect(result.indexResidue).toEqual([])

    // The shredded records' index side-cars are GONE (no value leak under the DEK).
    expect(idxIds().some((k) => k.endsWith('/i-1'))).toBe(false)
    expect(idxIds().some((k) => k.endsWith('/i-2'))).toBe(false)
    // buyer-2's side-car is intact (only the subject's index was purged).
    expect(idxIds().some((k) => k.endsWith('/i-3'))).toBe(true)
  })
})
