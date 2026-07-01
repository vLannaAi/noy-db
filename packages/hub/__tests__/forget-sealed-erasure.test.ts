/**
 * forget() erasure-completeness — H-1 (`_sealed_cek` survives) + M-1
 * (legacy DEK-sealed slots mis-counted as crypto-shredded).
 *
 * From the 2026-06-30 security review. Two real holes in `vault.forget()`:
 *
 *   - H-1: `sealRecordToHost()` persists the record's raw CEK sealed to an
 *     `at-*` host at `_sealed_cek/<collection>/<id>/<pid>`. forget() never
 *     touched that namespace, so a granted host holding a synced/backup body
 *     replica + the still-present `_sealed_cek` envelope could fully decrypt a
 *     record reported as erased. forget() must destroy those envelopes.
 *   - M-1: a record whose BODY is migrated (`_cek` present) but whose `_sealed`
 *     slot is a pre-#306 collection-DEK-derived legacy slot is NOT crypto-
 *     shredded by dropping `_cek` (the collection DEK is retained), yet the old
 *     blind count reported every slot as shredded. forget() must classify each
 *     slot and report DEK-derived ones as `sealedResidue`, not shredded.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { ConflictError } from '../src/kernel/errors.js'
import {
  generateDEK,
  wrapCek,
  encrypt,
  deriveSealedFieldKey,
} from '../src/kernel/enclave/crypto.js'
import { NOYDB_FORMAT_VERSION } from '../src/kernel/types.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { MemoryRecipientSealer } from '../src/with-party/team/managed-passphrase.js'
import { openSealedRecord } from '../src/with-audit/sealed-record/index.js'
import type { SealedCekDeliveryEnvelope } from '../src/with-audit/sealed-record/types.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'

/** In-memory store exposing raw stored envelopes for white-box assertions. */
function memory(): NoydbStore & { raw(c: string, col: string, id: string): EncryptedEnvelope | undefined } {
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

interface Person { id: string; subjectId: string; name: string; ssn: string }

const SECRET = 'forget-sealed-erasure-passphrase-2026'
const HOUR = 60 * 60 * 1000

function readDelivery(
  store: ReturnType<typeof memory>,
  vault: string,
  collection: string,
  id: string,
  pid: string,
): SealedCekDeliveryEnvelope {
  const env = store.raw(vault, '_sealed_cek', `${collection}/${id}/${pid}`)!
  return JSON.parse(env._data) as SealedCekDeliveryEnvelope
}

async function setup() {
  const store = memory()
  const db = await createNoydb({
    store, user: 'alice', secret: SECRET,
    historyStrategy: withHistory(),
    forgetStrategy: withForgetCascade({ subjects: { people: 'subjectId' } }),
  })
  const vault = await db.openVault('v')
  const people = vault.collection<Person, 'ssn'>('people', { perRecordKeys: true, sensitive: ['ssn'] })
  return { store, db, vault, people }
}

describe('forget() — H-1: erases `_sealed_cek` host-delivery envelopes', () => {
  it('the headline: a sealed-to-host record forgotten → envelope gone, count 1, host can no longer open', async () => {
    const { store, vault, people } = await setup()
    await people.put('p1', { id: 'p1', subjectId: 'subject-1', name: 'Ada', ssn: '123-45-6789' })

    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const { pid } = await vault.sealRecordToHost('people', 'p1', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })

    // The sealed-CEK delivery envelope exists, and the host CAN open the record
    // (capture a pre-forget body+delivery pair — the synced/backup replica a
    // host would hold).
    expect(store.raw('v', '_sealed_cek', `people/p1/${pid}`)).toBeDefined()
    const preDelivery = readDelivery(store, 'v', 'people', 'p1', pid)
    const preRecordEnv = store.raw('v', 'people', 'p1')!
    const opened = await openSealedRecord(preDelivery, preRecordEnv, host, 'people', 'p1')
    expect(JSON.parse(opened)).toMatchObject({ id: 'p1', name: 'Ada' })

    const result = await vault.forget('subject-1')

    // (a) the `_sealed_cek` envelope is GONE from the live store.
    expect(store.raw('v', '_sealed_cek', `people/p1/${pid}`)).toBeUndefined()
    // (b) reported.
    expect(result.sealedCekEnvelopesPurged).toBe(1)
    expect(result.sealedCekResidue).toEqual([])
    // (c) a host syncing the vault now finds NO delivery envelope to open with —
    // the only copy of the sealed raw CEK is destroyed.
    await expect(store.list('v', '_sealed_cek')).resolves.toEqual([])
  })

  it('multi-pid: two hosts sealed → forget deletes BOTH envelopes, count 2', async () => {
    const { store, vault, people } = await setup()
    await people.put('p1', { id: 'p1', subjectId: 'subject-1', name: 'Ada', ssn: '123-45-6789' })

    const hostA = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const hostB = new MemoryRecipientSealer({ id: 'kms:host-B' })
    await vault.sealRecordToHost('people', 'p1', hostA, { expiresAt: new Date(Date.now() + HOUR).toISOString() })
    await vault.sealRecordToHost('people', 'p1', hostB, { expiresAt: new Date(Date.now() + HOUR).toISOString() })
    expect(store.raw('v', '_sealed_cek', 'people/p1/kms:host-A')).toBeDefined()
    expect(store.raw('v', '_sealed_cek', 'people/p1/kms:host-B')).toBeDefined()

    const result = await vault.forget('subject-1')

    expect(store.raw('v', '_sealed_cek', 'people/p1/kms:host-A')).toBeUndefined()
    expect(store.raw('v', '_sealed_cek', 'people/p1/kms:host-B')).toBeUndefined()
    expect(result.sealedCekEnvelopesPurged).toBe(2)
  })
})

describe('forget() — M-1: classifies sealed slots (CEK-shreddable vs DEK-residue)', () => {
  it('a legacy DEK-derived slot is reported as residue, NOT counted shredded', async () => {
    const { store, people, vault } = await setup()

    // First put a normal record so the subject index registers p1 → subject-2.
    await people.put('p1', { id: 'p1', subjectId: 'subject-2', name: 'Ada', ssn: 'placeholder' })

    // Reach the REAL collection DEK white-box and forge the exact pre-#306
    // shape: body CEK-encrypted (`_cek` present) but `_sealed.ssn` derived off
    // the collection DEK (legacy). This is the M-1 hole: dropping `_cek` does
    // NOT crypto-shred a DEK-derived slot.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dek = await (people as any).getDEK('people') as CryptoKey
    const dekKey = await deriveSealedFieldKey(dek, 'people', 'ssn')
    const sealedEnc = await encrypt(JSON.stringify('123-45-6789'), dekKey)
    const slot = `${sealedEnc.iv}:${sealedEnc.data}`

    const cek = await generateDEK()
    const body = await encrypt(JSON.stringify({ id: 'p1', subjectId: 'subject-2', name: 'Ada' }), cek)
    const wrapped = await wrapCek(cek, dek)
    const forged: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: 2,
      _ts: new Date().toISOString(),
      _iv: body.iv,
      _data: body.data,
      _cek: wrapped,
      _sealed: { ssn: slot },
    }
    await store.put('v', 'people', 'p1', forged)

    const result = await vault.forget('subject-2')

    // DEK-derived → residue, NOT counted shredded.
    expect(result.sealedResidue).toContain('people:p1:ssn')
    expect(result.sealedFieldsShredded).toBe(0)
  })

  it('a normally-written CEK-derived slot is counted shredded, NOT residue', async () => {
    const { people, vault } = await setup()
    await people.put('p1', { id: 'p1', subjectId: 'subject-3', name: 'Ada', ssn: '123-45-6789' })

    const result = await vault.forget('subject-3')

    expect(result.sealedFieldsShredded).toBe(1)
    expect(result.sealedResidue).toEqual([])
  })
})

describe('forget() — regression: non-sealed, non-host-sealed erasure', () => {
  it('a plain perRecordKeys record forgets cleanly; new counts are all zero', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { notes: 'subjectId' } }),
    })
    const vault = await db.openVault('v')
    interface Note { id: string; subjectId: string; body: string }
    const notes = vault.collection<Note>('notes', { perRecordKeys: true })
    await notes.put('n1', { id: 'n1', subjectId: 'subject-9', body: 'hello' })

    const result = await vault.forget('subject-9')

    expect(result.recordsShredded).toBe(1)
    expect(result.sealedCekEnvelopesPurged).toBe(0)
    expect(result.sealedCekResidue).toEqual([])
    expect(result.sealedResidue).toEqual([])
    expect(result.sealedFieldsShredded).toBe(0)
  })
})
