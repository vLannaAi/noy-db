import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, FederationMovedError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

describe('hub prep for federation extraction', () => {
  it('FederationMovedError carries the stable code + API name', () => {
    const err = new FederationMovedError('openVaultGroup')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('FEDERATION_MOVED')
    expect(err.message).toContain('@klum-db/lobby')
    expect(err.message).toContain('openVaultGroup')
    expect(err.message).toContain('createLobby')
  })

  it('Noydb exposes isClosed reflecting lifecycle', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'correct-horse-battery-staple' })
    expect(db.isClosed).toBe(false)
    db.close()
    expect(db.isClosed).toBe(true)
  })
})

describe('federation entry methods throw FederationMovedError', () => {
  it('openVaultGroup throws', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'correct-horse-battery-staple' })
    await expect(db.openVaultGroup()).rejects.toBeInstanceOf(FederationMovedError)
  })
  it('openStateManagementVault throws', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'correct-horse-battery-staple' })
    await expect(db.openStateManagementVault()).rejects.toBeInstanceOf(FederationMovedError)
  })
  it('withVaultTemplate throws', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'correct-horse-battery-staple' })
    expect(() => db.withVaultTemplate()).toThrow(FederationMovedError)
  })
})
