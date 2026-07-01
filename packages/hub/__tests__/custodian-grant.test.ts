/**
 * FR-6 Task 4 — `grantCustodian` / `revokeCustodian` on `Noydb`.
 *
 * Owner-only custody API, defended in depth: the operation is gated
 * (`grant-custodian` / `revoke-user`, both fail-closed) AND the caller's
 * keyring must resolve to `owner` (an explicit `keyring.role !== 'owner'`
 * check). A custodian is granted under the `custodian` role and operates
 * every collection; `revokeCustodian` removes it again.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, PermissionDeniedError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'

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

interface Invoice { amount: number; status: string }

describe('FR-6 Task 4 — grantCustodian / revokeCustodian (owner-only custody API)', () => {
  const COMP = 'C400'
  // The custody API is gated; enable `grant-custodian` so the owner can mint a
  // custodian. `revoke-user` is enabled too so `revokeCustodian` is exercised.
  const POLICY = {
    gates: {
      'grant-custodian': { enabled: true, minTier: 1 },
      'revoke-user': { enabled: true, minTier: 1 },
    },
  } as const

  let adapter: NoydbStore
  let ownerDb: Noydb

  beforeEach(async () => {
    adapter = inlineMemory()
    ownerDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass', policy: POLICY })
    const comp = await ownerDb.openVault(COMP)
    await comp.collection<Invoice>('invoices').put('inv-001', { amount: 5000, status: 'draft' })
    await comp.collection<Invoice>('payments').put('pay-001', { amount: 3000, status: 'paid' })
  })

  it('owner grants a custodian who opens + reads/writes ALL collections', async () => {
    await expect(
      ownerDb.grantCustodian(COMP, { userId: 'firm-01', displayName: 'Firm', passphrase: 'firm-pass-long' }),
    ).resolves.not.toThrow()

    const firmDb = await createNoydb({ store: adapter, user: 'firm-01', secret: 'firm-pass-long' })
    const comp = await firmDb.openVault(COMP)
    // reads every collection
    expect((await comp.collection<Invoice>('invoices').get('inv-001'))?.amount).toBe(5000)
    expect((await comp.collection<Invoice>('payments').get('pay-001'))?.amount).toBe(3000)
    // writes every collection
    await expect(
      comp.collection<Invoice>('invoices').put('inv-002', { amount: 1000, status: 'new' }),
    ).resolves.not.toThrow()
    await expect(
      comp.collection<Invoice>('payments').put('pay-002', { amount: 7, status: 'x' }),
    ).resolves.not.toThrow()
  })

  it('(a) grantCustodian FAILS when the `grant-custodian` gate is disabled (fail-closed)', async () => {
    // Fresh vault + a NoyDB with NO policy: the `grant-custodian` built-in gate
    // is unconfigured, so it must fail closed even for the owner. (Using a
    // separate vault avoids reading C400's persisted gate-enabled policy.)
    const NO_GATE_COMP = 'C400-nogate'
    const noGateDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const comp = await noGateDb.openVault(NO_GATE_COMP)
    await comp.collection<Invoice>('invoices').put('inv-001', { amount: 1, status: 'x' })
    await expect(
      noGateDb.grantCustodian(NO_GATE_COMP, { userId: 'firm-02', displayName: 'Firm', passphrase: 'firm-pass-long' }),
    ).rejects.toThrow()
  })

  it('(b) grantCustodian FAILS when the caller is NOT the owner (admin tries)', async () => {
    await ownerDb.grant(COMP, { userId: 'admin-01', displayName: 'Admin', role: 'admin', passphrase: 'admin-pass' })
    const adminDb = await createNoydb({ store: adapter, user: 'admin-01', secret: 'admin-pass', policy: POLICY })
    await adminDb.openVault(COMP)
    await expect(
      adminDb.grantCustodian(COMP, { userId: 'firm-03', displayName: 'Firm', passphrase: 'firm-pass-long' }),
    ).rejects.toThrow(PermissionDeniedError)
  })

  it('(c) revokeCustodian (as owner) removes the custodian', async () => {
    await ownerDb.grantCustodian(COMP, { userId: 'firm-01', displayName: 'Firm', passphrase: 'firm-pass-long' })
    // sanity: the custodian can open before revocation
    const firmDb = await createNoydb({ store: adapter, user: 'firm-01', secret: 'firm-pass-long' })
    await expect(firmDb.openVault(COMP)).resolves.toBeTruthy()

    await expect(
      ownerDb.revokeCustodian(COMP, { userId: 'firm-01' }),
    ).resolves.not.toThrow()

    // after revocation the firm keyring is gone — a fresh open is denied
    const firmAfter = await createNoydb({ store: adapter, user: 'firm-01', secret: 'firm-pass-long' })
    await expect(firmAfter.openVault(COMP)).rejects.toThrow()
  })

  it('revokeCustodian FAILS when the caller is NOT the owner (admin tries)', async () => {
    await ownerDb.grantCustodian(COMP, { userId: 'firm-01', displayName: 'Firm', passphrase: 'firm-pass-long' })
    await ownerDb.grant(COMP, { userId: 'admin-01', displayName: 'Admin', role: 'admin', passphrase: 'admin-pass' })
    const adminDb = await createNoydb({ store: adapter, user: 'admin-01', secret: 'admin-pass', policy: POLICY })
    await adminDb.openVault(COMP)
    await expect(
      adminDb.revokeCustodian(COMP, { userId: 'firm-01' }),
    ).rejects.toThrow(PermissionDeniedError)
  })
})
