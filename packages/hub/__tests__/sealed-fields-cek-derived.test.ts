/**
 * #306 Slice B — sealed (`sensitive`) fields keyed off the per-record CEK.
 *
 * Before Slice B, `_sealed[field]` slots derived their key from the collection
 * DEK (`deriveSealedFieldKey`), identical for every record forever — so
 * `vault.forget()` (which drops `_cek`/`_sealed` but keeps the DEK) could NOT
 * crypto-shred them. Slice B derives the sealed-field key from the record's
 * per-record CEK (`deriveSealedFieldKeyFromCek`) on `perRecordKeys + sensitive`
 * collections, so dropping `_cek` makes `_sealed` irrecoverable — matching the
 * erasure guarantee `_data` already has.
 *
 * THE LINCHPIN is the dual-read fallback (Test 3): records sealed by the
 * pre-#306 code (CEK-encrypted body, DEK-derived `_sealed`) MUST still read.
 */
import { describe, it, expect, vi } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSealedRecord } from '../src/with-audit/sealed-record/index.js'
import { ConflictError } from '../src/kernel/errors.js'
import { buildRecordAad,
  generateDEK,
  wrapCek,
  unwrapCek,
  encrypt,
  deriveSealedFieldKey,
  deriveSealedFieldKeyFromCek,
  decrypt,
} from '../src/kernel/enclave/index.js'
import { NOYDB_FORMAT_VERSION } from '../src/kernel/types.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withForget } from '../src/with-audit/forget/index.js'

interface Person {
  id: string
  name: string
  ssn: string
}

/** In-memory store exposing the raw envelope map (`_data`) for white-box reads. */
function memoryStore(): NoydbStore & { _data: Map<string, Map<string, Map<string, EncryptedEnvelope>>> } {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    _data: data,
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        if (cn.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, snap) {
      const existing = data.get(v)
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      if (existing) for (const [cn, cm] of existing) if (cn.startsWith('_')) vm.set(cn, cm)
      data.set(v, vm)
    },
  }
}

const SECRET = 'sealed-cek-derived-secret-2026-pilot'

describe('#306 Slice B — sealed fields keyed off the per-record CEK', () => {
  it('Test 1 — round-trips a sealed field; non-sealed field stays plain', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'alice', secret: SECRET })
    const vault = await db.openVault('v')
    const people = vault.collection<Person, { sensitive: 'ssn' }>('people', { perRecordKeys: true, sensitive: ['ssn'] })
    await people.put('p1', { id: 'p1', name: 'Ada', ssn: '123-45-6789' })

    const rec = await people.get('p1')
    expect(rec).not.toBeNull()
    expect(rec!.name).toBe('Ada')                       // non-sealed field is plain
    expect(await rec!.ssn.reveal()).toBe('123-45-6789') // sealed field reveals
  })

  it('Test 2 — `_sealed` decrypts under the CEK-derived key, NOT the DEK-derived key', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault('v')
    const people = vault.collection<Person, { sensitive: 'ssn' }>('people', { perRecordKeys: true, sensitive: ['ssn'] })
    await people.put('p1', { id: 'p1', name: 'Ada', ssn: '123-45-6789' })

    const env = store._data.get('v')!.get('people')!.get('p1')!
    expect(env._cek).toBeDefined()
    const slot = env._sealed!.ssn!
    const sep = slot.indexOf(':')
    const iv = slot.slice(0, sep)
    const data = slot.slice(sep + 1)

    // White-box: reach the collection DEK and unwrap the record CEK.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dek = await (people as any).getDEK('people') as CryptoKey
    const cek = await unwrapCek(env._cek!, dek)

    // The CEK-derived key decrypts the slot; the DEK-derived key does not.
    const cekKey = await deriveSealedFieldKeyFromCek(cek, 'people', 'ssn')
    expect(JSON.parse(await decrypt(iv, data, cekKey))).toBe('123-45-6789')

    const dekKey = await deriveSealedFieldKey(dek, 'people', 'ssn')
    await expect(decrypt(iv, data, dekKey)).rejects.toThrow()
  })

  it('Test 3 — DUAL-READ: a legacy (DEK-sealed, CEK-bodied) record still reveals', async () => {
    // R1 data-loss guard. Forge the EXACT shape the pre-#306 published code
    // wrote on a `perRecordKeys + sensitive` collection: body CEK-encrypted
    // (`_cek` present) but `_sealed[field]` derived off the collection DEK.
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault('v')
    const people = vault.collection<Person, { sensitive: 'ssn' }>('people', { perRecordKeys: true, sensitive: ['ssn'] })

    // Reach the REAL collection DEK white-box.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dek = await (people as any).getDEK('people') as CryptoKey

    // Forge the legacy DEK-derived sealed slot.
    const dekKey = await deriveSealedFieldKey(dek, 'people', 'ssn')
    const sealedEnc = await encrypt(JSON.stringify('123-45-6789'), dekKey)
    const slot = `${sealedEnc.iv}:${sealedEnc.data}`

    // Forge a CEK-encrypted body (the legacy code DID use per-record CEKs for the body).
    const cek = await generateDEK()
    const body = await encrypt(JSON.stringify({ id: 'p1', name: 'Ada' }), cek, buildRecordAad({ collection: 'people', id: 'p1', version: 1 }))
    const wrapped = await wrapCek(cek, dek)

    const env: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: 1,
      _ts: new Date().toISOString(),
      _iv: body.iv,
      _data: body.data,
      _cek: wrapped,
      _sealed: { ssn: slot },
    }
    await store.put('v', 'people', 'p1', env)

    // Fresh db/vault/collection on the SAME store to defeat any decrypt cache.
    const db2 = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault2 = await db2.openVault('v')
    const people2 = vault2.collection<Person, { sensitive: 'ssn' }>('people', { perRecordKeys: true, sensitive: ['ssn'] })
    const rec = await people2.get('p1')
    expect(rec).not.toBeNull()
    expect(rec!.name).toBe('Ada')
    // The CEK-derived key is tried first (fails AES-GCM auth), then the DEK
    // fallback fires and decrypts the legacy slot — no data loss.
    expect(await rec!.ssn.reveal()).toBe('123-45-6789')
  })

  it('Test 4 — forget() crypto-shreds sealed fields (erasure proof)', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForget({ subjects: { people: 'subjectId' } }),
    })
    const vault = await db.openVault('v')
    interface Subj { id: string; subjectId: string; name: string; ssn: string }
    const people = vault.collection<Subj, { sensitive: 'ssn' }>('people', { perRecordKeys: true, sensitive: ['ssn'] })
    await people.put('p1', { id: 'p1', subjectId: 'data-subject-1', name: 'Ada', ssn: '123-45-6789' })

    // Capture the live sealed blob BEFORE forget.
    const before = store._data.get('v')!.get('people')!.get('p1')!
    const oldSlot = before._sealed!.ssn!
    const sep = oldSlot.indexOf(':')
    const oldIv = oldSlot.slice(0, sep)
    const oldData = oldSlot.slice(sep + 1)

    const result = await vault.forget('data-subject-1')
    expect(result.sealedFieldsShredded).toBe(1)

    // The live envelope is now a tombstone with no `_cek` and no `_sealed`.
    const tomb = store._data.get('v')!.get('people')!.get('p1')!
    expect(tomb._cek).toBeUndefined()
    expect(tomb._sealed).toBeUndefined()
    expect(tomb._data).toBe('')

    // The captured old slot is unrecoverable from the surviving collection DEK:
    // it was CEK-derived and the CEK is gone, so the DEK-derived key fails too.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dek = await (people as any).getDEK('people') as CryptoKey
    const dekKey = await deriveSealedFieldKey(dek, 'people', 'ssn')
    await expect(decrypt(oldIv, oldData, dekKey)).rejects.toThrow()
  })

  it('Test 5 — rotateRecordCek re-encrypts `_sealed` under the new CEK', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'alice', secret: SECRET, sealedRecordStrategy: withSealedRecord() })
    const vault = await db.openVault('v')
    const people = vault.collection<Person, { sensitive: 'ssn' }>('people', { perRecordKeys: true, sensitive: ['ssn'] })
    await people.put('p1', { id: 'p1', name: 'Ada', ssn: '123-45-6789' })

    const before = store._data.get('v')!.get('people')!.get('p1')!
    const oldSlot = before._sealed!.ssn!
    const oldCek = before._cek!

    await vault.rotateRecordCek('people', 'p1')

    // (a) reveal still works after rotation.
    const after = await people.get('p1')
    expect(await after!.ssn.reveal()).toBe('123-45-6789')

    // (b) the new sealed blob differs (re-encrypted, not carried forward).
    const env = store._data.get('v')!.get('people')!.get('p1')!
    const newSlot = env._sealed!.ssn!
    expect(newSlot).not.toBe(oldSlot)
    expect(env._cek).not.toBe(oldCek)

    // (c) the OLD CEK can no longer decrypt the NEW slot.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dek = await (people as any).getDEK('people') as CryptoKey
    const oldCekKey = await unwrapCek(oldCek, dek)
    const sep = newSlot.indexOf(':')
    const nIv = newSlot.slice(0, sep)
    const nData = newSlot.slice(sep + 1)
    const oldDerived = await deriveSealedFieldKeyFromCek(oldCekKey, 'people', 'ssn')
    await expect(decrypt(nIv, nData, oldDerived)).rejects.toThrow()
  })

  it('Test 6 — the #306 construction warning no longer fires', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const db = await createNoydb({ store: memoryStore(), user: 'alice', secret: SECRET })
      const vault = await db.openVault('v')
      vault.collection<Person, { sensitive: 'ssn' }>('people', { perRecordKeys: true, sensitive: ['ssn'] })
      const fired = warn.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' &&
          (arg.includes('record-scoped sealing (#306)') || arg.includes('leaves its sealed fields recoverable'))),
      )
      expect(fired).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})
