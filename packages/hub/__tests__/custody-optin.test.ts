/**
 * Gate test for the sovereign-custody (FR-6) capability (S4). `db.grantCustodian`
 * / `db.revokeCustodian` (and the `vault.custody.*` facade that composes them)
 * throw `CustodyNotEnabledError` unless `custodyStrategy: withCustody()` is passed
 * to createNoydb; opting in makes them live. The gate fires BEFORE the
 * policy/owner checks, so the reject-path setups must also opt in. The
 * lower-level `liberateVault` free function stays ungated.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, CustodyNotEnabledError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withCustody } from '../src/with-party/custody/index.js'

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

const POLICY = {
  gates: { 'grant-custodian': { enabled: true, minTier: 1 } },
} as const
const VAULT = 'C-optin'

describe('custody opt-in gate (S4)', () => {
  it('throws CustodyNotEnabledError when not opted in', async () => {
    const adapter = inlineMemory()
    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass', policy: POLICY })
    await db.openVault(VAULT)
    // db-level primitive
    await expect(
      db.grantCustodian(VAULT, { userId: 'firm-01', displayName: 'Firm', passphrase: 'firm-pass-long' }),
    ).rejects.toThrow(CustodyNotEnabledError)
    // vault.custody.* facade routes through the same gate
    const vault = await db.openVault(VAULT)
    await expect(
      vault.custody.grantCustodian({ userId: 'firm-01', displayName: 'Firm', passphrase: 'firm-pass-long' }),
    ).rejects.toThrow(CustodyNotEnabledError)
    await expect(
      vault.custody.liberate({ newOwnerId: 'x', newOwnerPassphrase: 'x-pass-long', legalBasis: 'nope' }),
    ).rejects.toThrow(CustodyNotEnabledError)
  })

  it('works when opted in via withCustody()', async () => {
    const adapter = inlineMemory()
    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass', policy: POLICY, custodyStrategy: withCustody() })
    await db.openVault(VAULT)
    await expect(
      db.grantCustodian(VAULT, { userId: 'firm-01', displayName: 'Firm', passphrase: 'firm-pass-long' }),
    ).resolves.not.toThrow()
    // the minted custodian can open the vault
    const firmDb = await createNoydb({ store: adapter, user: 'firm-01', secret: 'firm-pass-long' })
    await expect(firmDb.openVault(VAULT)).resolves.toBeTruthy()
  })
})
