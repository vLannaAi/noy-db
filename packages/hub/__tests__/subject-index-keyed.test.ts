/**
 * M-2 (security): the subject-index record id must be a vault-DEK-keyed PRF
 * (HMAC over the `_subject_index` DEK), not an unsalted `sha256Hex(subjectId)`
 * (offline brute-forceable). The encrypted ref-list is padded to bucketed
 * lengths so its `_data` length does not leak the record count.
 *
 * Back-compat: forget() must still find + erase records indexed under the
 * LEGACY sha256 key form (dual-lookup), or pre-existing subjects become
 * un-forgettable.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { ConflictError } from '../src/kernel/errors.js'
import { withForget } from '../src/with-audit/forget/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { generateDEK } from '../src/kernel/enclave/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import {
  addSubjectRef,
  removeSubjectRef,
  lookupSubject,
} from '../src/with-audit/forget/subject-index.js'

async function sha256HexUtf8(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function toMemory(): NoydbStore & {
  raw(c: string, col: string, id: string): EncryptedEnvelope | undefined
  rawList(c: string, col: string): string[]
} {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
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
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        s[n] = r
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

interface Invoice { id: string; buyerId: string; amount: number }
const SECRET = 'subject-index-test-secret-1234'

async function buildDb(store: NoydbStore) {
  const db = await createNoydb({
    store, user: 'alice', secret: SECRET,
    historyStrategy: withHistory(),
    forgetStrategy: withForget({ subjects: { invoices: 'buyerId' } }),
  })
  const vault = await db.openVault('v')
  return { db, vault }
}

describe('M-2 — subject index keyed id + bucketed ref list', () => {
  it('the stored index id is NOT sha256Hex(subjectId)', async () => {
    const store = toMemory()
    const { vault } = await buildDb(store)
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 100 })

    const keys = store.rawList('v', '_subject_index')
    expect(keys.length).toBe(1)
    const legacy = await sha256HexUtf8('buyer-1')
    expect(keys).not.toContain(legacy)
  })

  it('two subjects with different small ref counts produce equal-length _data (bucketed)', async () => {
    const store = toMemory()
    const { vault } = await buildDb(store)
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-A', amount: 1 })   // A: 1 ref
    await invoices.put('i-2', { id: 'i-2', buyerId: 'buyer-B', amount: 2 })   // B: 2 refs
    await invoices.put('i-3', { id: 'i-3', buyerId: 'buyer-B', amount: 3 })

    const keys = store.rawList('v', '_subject_index')
    expect(keys.length).toBe(2)
    const lens = keys.map(k => store.raw('v', '_subject_index', k)!._data.length)
    expect(lens[0]).toBe(lens[1])
  })

  it('forget() still erases a record indexed under the LEGACY sha256 key form', async () => {
    const store = toMemory()
    const { vault } = await buildDb(store)
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', amount: 100 })

    // Simulate a legacy deployment. This used to RELOCATE buyer-1's entry from
    // the keyed id to the legacy sha256 id, body unchanged — which #1041 now
    // refuses, and rightly: relocating an envelope to a different id is the
    // attack AAD exists to stop, so a fixture cannot use it to fake history.
    //
    // A legacy entry is therefore MINTED at the legacy address instead: same
    // ref list, sealed against the id it actually lives at. That is what a real
    // pre-migration deployment would contain.
    const keyedId = store.rawList('v', '_subject_index')[0]!
    const keyedEnv = store.raw('v', '_subject_index', keyedId)!
    const legacyId = await sha256HexUtf8('buyer-1')
    const { encrypt, buildRecordAad, openEnvelopeJson } = await import('../src/kernel/enclave/index.js')
    const subjDek = await vault._introspectState().getDEK('_subject_index')
    const body = await openEnvelopeJson({ collection: '_subject_index', id: keyedId }, keyedEnv, subjDek)
    const { iv, data } = await encrypt(body, subjDek, buildRecordAad({ collection: '_subject_index', id: legacyId }))
    await store.put('v', '_subject_index', legacyId, { ...keyedEnv, _iv: iv, _data: data })
    await store.delete('v', '_subject_index', keyedId)

    const result = await vault.forget('buyer-1')
    expect(result.recordsShredded).toBe(1)
    expect(await invoices.get('i-1')).toBeNull()
    expect(store.raw('v', 'invoices', 'i-1')!._data).toBe('')
    // The legacy index entry was cleaned up (empty → deleted).
    expect(store.rawList('v', '_subject_index')).not.toContain(legacyId)
  })

  it('unit: dual-lookup finds + removes a legacy bare-array entry', async () => {
    const store = toMemory()
    const dek = await generateDEK()
    const getDEK = async () => dek
    // Hand-write a legacy entry: sha256 key + bare-array body encrypted under DEK.
    const legacyId = await sha256HexUtf8('buyer-L')
    const { encrypt, buildRecordAad } = await import('../src/kernel/enclave/index.js')
    // #1041: seal against the address it is stored at.
    const { iv, data } = await encrypt(JSON.stringify([{ collection: 'invoices', id: 'i-L' }]), dek, buildRecordAad({ collection: '_subject_index', id: legacyId }))
    await store.put('v', '_subject_index', legacyId, {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: iv, _data: data,
    } as EncryptedEnvelope)

    const found = await lookupSubject(store, 'v', getDEK, true, 'buyer-L')
    expect(found).toEqual([{ collection: 'invoices', id: 'i-L' }])

    await removeSubjectRef(store, 'v', getDEK, true, 'buyer-L', { collection: 'invoices', id: 'i-L' })
    expect(await lookupSubject(store, 'v', getDEK, true, 'buyer-L')).toEqual([])
    expect(store.rawList('v', '_subject_index')).not.toContain(legacyId)
  })

  it('unit: a new write lands under the keyed id, not sha256', async () => {
    const store = toMemory()
    const dek = await generateDEK()
    const getDEK = async () => dek
    await addSubjectRef(store, 'v', getDEK, true, 'buyer-N', { collection: 'invoices', id: 'i-N' })
    const legacyId = await sha256HexUtf8('buyer-N')
    expect(store.rawList('v', '_subject_index')).not.toContain(legacyId)
    expect(await lookupSubject(store, 'v', getDEK, true, 'buyer-N')).toEqual([{ collection: 'invoices', id: 'i-N' }])
  })
})
