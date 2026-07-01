/**
 * M-4 (security): sealed-record expiry must fail CLOSED.
 *
 * `Date.parse('')` / non-ISO → NaN, and `NaN <= Date.now()` is `false`, so the
 * old `Date.parse(x) <= Date.now()` checks SKIPPED a malformed expiry → an
 * eternal grant. Fix: reject a malformed/empty `expiresAt` at seal time, and
 * fail closed (`!Number.isFinite(t) || t <= now → throw`) at open time.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { ConflictError, SealedRecordExpiredError, ValidationError } from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { MemoryRecipientSealer } from '../src/with-party/team/managed-passphrase.js'
import { openSealedRecord, withSealedRecord } from '../src/with-audit/sealed-record/index.js'
import { bufferToBase64 } from '../src/kernel/enclave/crypto.js'
import type { SealedCekDeliveryEnvelope, SealedCekBinding } from '../src/with-audit/sealed-record/types.js'

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
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

interface Doc { id: string; secret: string }
const SECRET = 'test-passphrase-1234'
const HOUR = 60 * 60 * 1000

async function setup() {
  const store = memory()
  const db = await createNoydb({ store, user: 'alice', secret: SECRET, sealedRecordStrategy: withSealedRecord() })
  const vault = await db.openVault('v')
  const docs = vault.collection<Doc>('docs', { perRecordKeys: true })
  return { store, vault, docs }
}

describe('M-4 — sealed-record expiry fails closed', () => {
  it('seal time rejects an empty expiresAt', async () => {
    const { vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 's' })
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    await expect(
      vault.sealRecordToHost('docs', 'd-1', host, { expiresAt: '' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('seal time rejects a non-ISO expiresAt', async () => {
    const { vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 's' })
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    await expect(
      vault.sealRecordToHost('docs', 'd-1', host, { expiresAt: 'not-a-date' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('open time fails closed when the sealed binding carries a malformed expiresAt', async () => {
    // Craft a delivery whose CLEAR-TEXT envelope expiry is valid (passes the
    // fast-path), but whose authoritative sealed binding expiry is ''. The
    // old code skipped the NaN check and opened; fail-closed must throw.
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const hint = await host.publishRecipientHint()
    const binding: SealedCekBinding = {
      collection: 'docs', id: 'd-1',
      cek: bufferToBase64(new Uint8Array(32)),
      expiresAt: '', // malformed authoritative expiry
    }
    const sealed = await host.sealForRecipient(new TextEncoder().encode(JSON.stringify(binding)), hint)
    const delivery: SealedCekDeliveryEnvelope = {
      v: 1, _noydb_sealed_cek: 1, pid: hint.pid,
      payload: bufferToBase64(sealed),
      expiresAt: new Date(Date.now() + HOUR).toISOString(), // valid → passes fast-path
    }
    const recordEnv = { _iv: 'AAAA', _data: 'AAAA' }
    await expect(
      openSealedRecord(delivery, recordEnv, host, 'docs', 'd-1'),
    ).rejects.toBeInstanceOf(SealedRecordExpiredError)
  })

  it('a valid future expiry still opens', async () => {
    const { store, vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 'the eagle lands at dawn' })
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const { pid } = await vault.sealRecordToHost('docs', 'd-1', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })
    const delivery = JSON.parse(store.raw('v', '_sealed_cek', `docs/d-1/${pid}`)!._data) as SealedCekDeliveryEnvelope
    const recordEnv = store.raw('v', 'docs', 'd-1')!
    const json = await openSealedRecord(delivery, recordEnv, host, 'docs', 'd-1')
    expect(JSON.parse(json)).toMatchObject({ id: 'd-1', secret: 'the eagle lands at dawn' })
  })

  it('a valid past expiry still throws as before', async () => {
    const { store, vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 's' })
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    // Past expiry is a valid timestamp → accepted at seal time, rejected at open.
    const { pid } = await vault.sealRecordToHost('docs', 'd-1', host, {
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    })
    const delivery = JSON.parse(store.raw('v', '_sealed_cek', `docs/d-1/${pid}`)!._data) as SealedCekDeliveryEnvelope
    const recordEnv = store.raw('v', 'docs', 'd-1')!
    await expect(
      openSealedRecord(delivery, recordEnv, host, 'docs', 'd-1'),
    ).rejects.toBeInstanceOf(SealedRecordExpiredError)
  })
})
