/**
 * #306 Slice C — ledger `payloadHash` attests to sealed fields (`_sealed`).
 *
 * Before this slice, `envelopePayloadHash` hashed only `envelope._data`, so a
 * tampered or erased sealed-field slot (`_sealed[field]`) was INVISIBLE to
 * `vault.verifyBackupIntegrity()`. Slice C widens the hash to also bind
 * `_sealed` — backward-compatibly: a record with NO `_sealed` hashes exactly
 * as before (`sha256Hex(_data)`), so every existing ledger / non-sealed backup
 * verifies byte-identically.
 *
 * The end-to-end tamper/erasure detection tests (3 + 4) are the point of the
 * slice — that behavior did NOT exist before.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { ConflictError } from '../src/errors.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { NOYDB_FORMAT_VERSION } from '../src/kernel/types.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { envelopePayloadHash } from '../src/with-commit/history/ledger/hash.js'
import { sha256Hex } from '../src/with-commit/history/ledger/entry.js'

interface Person {
  id: string
  name: string
  ssn?: string
}

/** In-memory store exposing the raw envelope map (`_data`) for white-box tampering. */
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
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      const existing = data.get(v)
      if (existing) for (const [cn, cm] of existing) if (cn.startsWith('_')) vm.set(cn, cm)
      data.set(v, vm)
    },
  }
}

function envelope(fields: Partial<EncryptedEnvelope>): EncryptedEnvelope {
  return {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: '2026-01-01T00:00:00.000Z',
    _iv: 'iv',
    _data: 'abc',
    ...fields,
  } as EncryptedEnvelope
}

describe('#306 Slice C — envelopePayloadHash binds _sealed', () => {
  it('1. back-compat: no _sealed hashes exactly as sha256Hex(_data); null → ""', async () => {
    const env = envelope({ _data: 'abc' })
    expect(await envelopePayloadHash(env)).toBe(await sha256Hex('abc'))
    expect(await envelopePayloadHash(null)).toBe('')
  })

  it('2. _sealed is bound, order-independent, and widens the hash', async () => {
    const base = { _data: 'abc' }
    const a = envelope({ ...base, _sealed: { ssn: 'AAA' } })
    const b = envelope({ ...base, _sealed: { ssn: 'BBB' } })
    // Same _data, different _sealed → different hash.
    expect(await envelopePayloadHash(a)).not.toBe(await envelopePayloadHash(b))

    // Same _data + same _sealed entries in DIFFERENT key order → same hash.
    const order1 = envelope({ ...base, _sealed: { ssn: 'AAA', dob: 'CCC' } })
    const order2 = envelope({ ...base, _sealed: { dob: 'CCC', ssn: 'AAA' } })
    expect(await envelopePayloadHash(order1)).toBe(await envelopePayloadHash(order2))

    // A sealed envelope's hash differs from the bare sha256Hex(_data) — proves
    // the widening actually happened (it's not silently the legacy hash).
    expect(await envelopePayloadHash(a)).not.toBe(await sha256Hex('abc'))
  })

  it('3. end-to-end: tampering a stored _sealed slot trips verifyBackupIntegrity (kind:data)', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'test-passphrase-1234',
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('firm')
    const people = vault.collection<Person, 'ssn'>('people', { perRecordKeys: true, sensitive: ['ssn'] })
    await people.put('p1', { id: 'p1', name: 'Ann', ssn: '123-45-6789' })

    expect((await vault.verifyBackupIntegrity()).ok).toBe(true)

    // Tamper directly in the adapter: reverse the sealed ssn ciphertext.
    const raw = store._data.get('firm')!.get('people')!.get('p1')!
    const sealedSsn = raw._sealed?.ssn
    expect(sealedSsn).toBeDefined()
    const tampered = { ...raw, _sealed: { ...raw._sealed, ssn: sealedSsn!.split('').reverse().join('') } }
    store._data.get('firm')!.get('people')!.set('p1', tampered as EncryptedEnvelope)

    const result = await vault.verifyBackupIntegrity()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('data')
      if (result.kind === 'data') {
        expect(result.collection).toBe('people')
        expect(result.id).toBe('p1')
      }
    }
  })

  it('4. end-to-end: erasing the stored _sealed slot trips verifyBackupIntegrity (kind:data)', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'test-passphrase-1234',
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('firm')
    const people = vault.collection<Person, 'ssn'>('people', { perRecordKeys: true, sensitive: ['ssn'] })
    await people.put('p1', { id: 'p1', name: 'Ann', ssn: '123-45-6789' })

    expect((await vault.verifyBackupIntegrity()).ok).toBe(true)

    // Erase the sealed map entirely, leaving _data intact.
    const raw = store._data.get('firm')!.get('people')!.get('p1')!
    const { _sealed, ...withoutSealed } = raw
    void _sealed
    store._data.get('firm')!.get('people')!.set('p1', withoutSealed as EncryptedEnvelope)

    const result = await vault.verifyBackupIntegrity()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('data')
  })

  it('5. regression: a non-sealed perRecordKeys record still verifies and still trips on _data tamper', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'test-passphrase-1234',
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('firm')
    const people = vault.collection<Person>('people', { perRecordKeys: true })
    await people.put('p1', { id: 'p1', name: 'Ann' })

    expect((await vault.verifyBackupIntegrity()).ok).toBe(true)

    const raw = store._data.get('firm')!.get('people')!.get('p1')!
    expect(raw._sealed).toBeUndefined()
    const tampered = { ...raw, _data: raw._data.split('').reverse().join('') }
    store._data.get('firm')!.get('people')!.set('p1', tampered as EncryptedEnvelope)

    const result = await vault.verifyBackupIntegrity()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('data')
  })
})
