/**
 * M-5 (security): `revokeSealedRecord` is SOFT by default (it only deletes the
 * delivery envelope — a host that already fetched the sealed CEK keeps decrypt
 * capability). The opt-in `{ hard: true }` rotates the record CEK so a
 * pre-revoke sealed CEK can no longer open the (now re-encrypted) record.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { ConflictError, TamperedError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { MemoryRecipientSealer } from '../src/with-party/team/managed-passphrase.js'
import { openSealedRecord } from '../src/with-audit/sealed-record/index.js'
import type { SealedCekDeliveryEnvelope } from '../src/with-audit/sealed-record/types.js'

function memory(): NoydbStore & { raw(c: string, col: string, id: string): EncryptedEnvelope | undefined } {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
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

interface Doc { id: string; secret: string }
const SECRET = 'test-passphrase-1234'
const HOUR = 60 * 60 * 1000

async function setup() {
  const store = memory()
  const db = await createNoydb({ store, user: 'alice', secret: SECRET })
  const vault = await db.openVault('v')
  const docs = vault.collection<Doc>('docs', { perRecordKeys: true })
  return { store, vault, docs }
}

describe('M-5 — sealed-record revoke softness', () => {
  it('default revoke is SOFT: a host that already fetched the CEK can still decrypt', async () => {
    const { store, vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 'the eagle lands at dawn' })
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const { pid } = await vault.sealRecordToHost('docs', 'd-1', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })
    // Host fetches the delivery before revocation.
    const delivery = JSON.parse(store.raw('v', '_sealed_cek', `docs/d-1/${pid}`)!._data) as SealedCekDeliveryEnvelope

    await vault.revokeSealedRecord('docs', 'd-1', pid) // default = soft

    // Delivery envelope gone from the store...
    expect(store.raw('v', '_sealed_cek', `docs/d-1/${pid}`)).toBeUndefined()
    // ...but the already-fetched copy still opens the (un-rotated) record.
    const recordEnv = store.raw('v', 'docs', 'd-1')!
    const json = await openSealedRecord(delivery, recordEnv, host, 'docs', 'd-1')
    expect(JSON.parse(json)).toMatchObject({ secret: 'the eagle lands at dawn' })
  })

  it('{ hard: true } rotates: a pre-revoke sealed CEK no longer opens the record', async () => {
    const { store, vault, docs } = await setup()
    await docs.put('d-1', { id: 'd-1', secret: 'the eagle lands at dawn' })
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })
    const { pid } = await vault.sealRecordToHost('docs', 'd-1', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })
    const delivery = JSON.parse(store.raw('v', '_sealed_cek', `docs/d-1/${pid}`)!._data) as SealedCekDeliveryEnvelope

    await vault.revokeSealedRecord('docs', 'd-1', pid, { hard: true })

    // The live record was re-encrypted under a fresh CEK → the old sealed CEK
    // fails the GCM auth tag.
    const recordEnv = store.raw('v', 'docs', 'd-1')!
    await expect(
      openSealedRecord(delivery, recordEnv, host, 'docs', 'd-1'),
    ).rejects.toBeInstanceOf(TamperedError)
    // And the delivery envelope is gone too.
    expect(store.raw('v', '_sealed_cek', `docs/d-1/${pid}`)).toBeUndefined()
  })
})
