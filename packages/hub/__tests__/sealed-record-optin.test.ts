/**
 * Gate test for the sealed-record (grantor-side) capability (S4). The vault
 * methods `sealRecordToHost` / `revokeSealedRecord` / `rotateRecordCek` throw
 * `SealedRecordNotEnabledError` unless `sealedRecordStrategy: withSealedRecord()`
 * is passed to createNoydb; opting in makes them live. The host-side
 * `openSealedRecord` opener is a separate ungated function.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { ConflictError, SealedRecordNotEnabledError } from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { MemoryRecipientSealer } from '../src/with-party/team/managed-passphrase.js'
import { withSealedRecord } from '../src/with-audit/sealed-record/index.js'

interface Doc { id: string; name: string }
const SECRET = 'test-passphrase-1234'
const HOUR = 60 * 60 * 1000

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const coll = (c: string, col: string) => {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let cl = comp.get(col); if (!cl) { cl = new Map(); comp.set(col, cl) }
    return cl
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const cl = coll(c, col); const ex = cl.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      cl.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const cl = store.get(c)?.get(col); return cl ? [...cl.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const snap: VaultSnapshot = {}
      if (comp) for (const [cn, cl] of comp) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cl) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(c, snap) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cl = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cl.set(id, e)
        comp.set(cn, cl)
      }
      store.set(c, comp)
    },
  }
}

describe('sealed-record opt-in gate (S4)', () => {
  it('throws SealedRecordNotEnabledError when not opted in', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: SECRET })
    const vault = await db.openVault('v')
    const docs = vault.collection<Doc>('docs', { perRecordKeys: true })
    await docs.put('d-1', { id: 'd-1', name: 'secret' })
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })

    await expect(vault.sealRecordToHost('docs', 'd-1', host, { expiresAt: new Date(Date.now() + HOUR).toISOString() }))
      .rejects.toThrow(SealedRecordNotEnabledError)
    await expect(vault.revokeSealedRecord('docs', 'd-1', 'kms:host-A')).rejects.toThrow(SealedRecordNotEnabledError)
    await expect(vault.rotateRecordCek('docs', 'd-1')).rejects.toThrow(SealedRecordNotEnabledError)
  })

  it('works when opted in via withSealedRecord()', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: SECRET, sealedRecordStrategy: withSealedRecord() })
    const vault = await db.openVault('v')
    const docs = vault.collection<Doc>('docs', { perRecordKeys: true })
    await docs.put('d-1', { id: 'd-1', name: 'secret' })
    const host = new MemoryRecipientSealer({ id: 'kms:host-A' })

    const { pid, envelopeKey } = await vault.sealRecordToHost('docs', 'd-1', host, {
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    })
    expect(pid).toBe('kms:host-A')
    expect(envelopeKey).toContain('docs/d-1/')
    await expect(vault.rotateRecordCek('docs', 'd-1')).resolves.toBeUndefined()
  })
})
