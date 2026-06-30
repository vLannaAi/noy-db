/**
 * FR-6 Task 1 — the `custodian` role.
 *
 * A custodian is operationally admin-rank: rw + access on ALL collections
 * and receives every collection DEK on grant. BUT it is provably unable to
 * grant or revoke, and an admin cannot mint one — only the (Deed) owner can.
 *
 * (Task 2 will additionally block rotate / sever / extract; Task 4 adds the
 * `grantCustodian`/`revokeCustodian` owner API. This file covers the kernel
 * role/capability matrix + the two new built-in gate names fail-closed.)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, PermissionDeniedError, ReadOnlyError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import { checkGate, PolicyDeniedError } from '../src/policy/index.js'
import { putCredential } from '../src/with-party/team/sync-credentials.js'
import { extractPartition } from '../src/with-fork/bundle/extract-partition.js'

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

describe('custodian role', () => {
  let adapter: NoydbStore
  let ownerDb: Noydb
  const COMP = 'C200'

  beforeEach(async () => {
    adapter = inlineMemory()
    ownerDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const comp = await ownerDb.openVault(COMP)
    await comp.collection<Invoice>('invoices').put('inv-001', { amount: 5000, status: 'draft' })
    await comp.collection<Invoice>('payments').put('pay-001', { amount: 3000, status: 'paid' })
  })

  describe('(a) owner grants a custodian who operates ALL collections', () => {
    let custodianDb: Noydb

    beforeEach(async () => {
      await ownerDb.grant(COMP, {
        userId: 'cust-01', displayName: 'Custodian', role: 'custodian',
        passphrase: 'cust-pass',
      })
      custodianDb = await createNoydb({ store: adapter, user: 'cust-01', secret: 'cust-pass' })
    })

    it('reads every collection (no explicit permissions needed)', async () => {
      const comp = await custodianDb.openVault(COMP)
      expect((await comp.collection<Invoice>('invoices').get('inv-001'))?.amount).toBe(5000)
      expect((await comp.collection<Invoice>('payments').get('pay-001'))?.amount).toBe(3000)
    })

    it('writes every collection', async () => {
      const comp = await custodianDb.openVault(COMP)
      await expect(
        comp.collection<Invoice>('invoices').put('inv-002', { amount: 1000, status: 'new' }),
      ).resolves.not.toThrow()
      await expect(
        comp.collection<Invoice>('payments').put('pay-002', { amount: 7, status: 'x' }),
      ).resolves.not.toThrow()
    })
  })

  describe('(b)+(c) custodian cannot grant or revoke', () => {
    let custodianDb: Noydb

    beforeEach(async () => {
      await ownerDb.grant(COMP, {
        userId: 'cust-01', displayName: 'Custodian', role: 'custodian',
        passphrase: 'cust-pass',
      })
      // a separate user the custodian might try to revoke
      await ownerDb.grant(COMP, { userId: 'viewer-01', displayName: 'V', role: 'viewer', passphrase: 'p' })
      custodianDb = await createNoydb({ store: adapter, user: 'cust-01', secret: 'cust-pass' })
    })

    it('cannot grant any role', async () => {
      await expect(
        custodianDb.grant(COMP, { userId: 'x', displayName: 'X', role: 'viewer', passphrase: 'p' }),
      ).rejects.toThrow(PermissionDeniedError)
      await expect(
        custodianDb.grant(COMP, { userId: 'y', displayName: 'Y', role: 'operator', passphrase: 'p', permissions: { invoices: 'rw' } }),
      ).rejects.toThrow(PermissionDeniedError)
    })

    it('cannot revoke anyone', async () => {
      await expect(
        custodianDb.revoke(COMP, { userId: 'viewer-01' }),
      ).rejects.toThrow(PermissionDeniedError)
    })
  })

  describe('(d) admin cannot grant a custodian — only the owner can', () => {
    it('admin → custodian is denied', async () => {
      await ownerDb.grant(COMP, { userId: 'admin-01', displayName: 'Admin', role: 'admin', passphrase: 'admin-pass' })
      const adminDb = await createNoydb({ store: adapter, user: 'admin-01', secret: 'admin-pass' })
      await expect(
        adminDb.grant(COMP, { userId: 'cust-from-admin', displayName: 'C', role: 'custodian', passphrase: 'p' }),
      ).rejects.toThrow(PermissionDeniedError)
    })

    it('owner → custodian succeeds (control)', async () => {
      await expect(
        ownerDb.grant(COMP, { userId: 'cust-02', displayName: 'C', role: 'custodian', passphrase: 'p' }),
      ).resolves.not.toThrow()
    })
  })

  describe('audit of other Role comparison sites', () => {
    let custodianDb: Noydb

    beforeEach(async () => {
      await ownerDb.grant(COMP, {
        userId: 'cust-01', displayName: 'Custodian', role: 'custodian',
        passphrase: 'cust-pass',
      })
      custodianDb = await createNoydb({ store: adapter, user: 'cust-01', secret: 'cust-pass' })
    })

    it('sync-credentials.ts: custodian CANNOT issue sync credentials (firm infra, not operational scope)', async () => {
      const comp = await custodianDb.openVault(COMP)
      const { keyring } = comp._introspectState()
      await expect(
        putCredential(adapter, COMP, keyring, { adapterId: 'gdrive', tokenType: 'Bearer', accessToken: 'x' }),
      ).rejects.toThrow(PermissionDeniedError)
    })

    it('tiers.ts: custodian operates non-zero tiers like admin (auto-mints the tier DEK)', async () => {
      const comp = await custodianDb.openVault(COMP)
      const docs = comp.collection<{ id: string; body: string }>('tiered', { tiers: [0, 1, 2] })
      // assertTierAccess + the elevate tier-reach check both treat custodian as
      // admin-rank, so writing at a tier whose DEK does not yet exist succeeds.
      await expect(docs.putAtTier('d1', { id: 'd1', body: 'secret' }, 2)).resolves.not.toThrow()
      expect(((await docs.getAtTier('d1')) as { body?: string } | null)?.body).toBe('secret')
    })
  })
})

describe('FR-6 Task 2 — custodian blocked from rotate / sever / extract', () => {
  // The custodian operates fully but is the de-facto authority WITHOUT
  // ownership: it must be provably unable to re-key, destructively sever, or
  // extract-and-sever. These three meta-capabilities are owner-only.
  const COMP = 'C201'
  // The withdrawal path is itself gated by `client-unilateral-withdraw`; enable
  // it so the role guard (not the gate) is what rejects the custodian.
  const POLICY = { gates: { 'client-unilateral-withdraw': { enabled: true, minTier: 1 } } } as const

  interface Inv { id: string; amount: number; status: string }
  let adapter: NoydbStore
  let ownerDb: Noydb
  let custodianDb: Noydb

  beforeEach(async () => {
    adapter = inlineMemory()
    ownerDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass', policy: POLICY })
    const comp = await ownerDb.openVault(COMP)
    await comp.collection<Inv>('invoices').put('inv-001', { id: 'inv-001', amount: 5000, status: 'draft' })
    await comp.collection<Inv>('payments').put('pay-001', { id: 'pay-001', amount: 3000, status: 'paid' })
    await ownerDb.grant(COMP, {
      userId: 'cust-01', displayName: 'Custodian', role: 'custodian', passphrase: 'cust-pass',
    })
    custodianDb = await createNoydb({ store: adapter, user: 'cust-01', secret: 'cust-pass' })
  })

  it('(a) custodian cannot rotate keys', async () => {
    await custodianDb.openVault(COMP)
    await expect(
      custodianDb.rotate(COMP, ['invoices']),
    ).rejects.toThrow(PermissionDeniedError)
  })

  it('(b) custodian cannot destructively withdraw/sever — redirected to liberate (delete)', async () => {
    const comp = await custodianDb.openVault(COMP)
    const p = comp.user.unilateralWithdrawal({
      disposition: 'delete', legalBasis: 'x', reKey: { passphrase: 'new-pw' },
    })
    await expect(p).rejects.toThrow(ReadOnlyError)
    await expect(p).rejects.toThrow(/liberate|custody/)
    // live records untouched (nothing severed)
    expect((await comp.collection<Inv>('invoices').get('inv-001'))?.amount).toBe(5000)
  })

  it('(b) custodian cannot destructively withdraw/sever — redirected to liberate (freeze)', async () => {
    const comp = await custodianDb.openVault(COMP)
    await expect(
      comp.user.unilateralWithdrawal({
        disposition: 'freeze', legalBasis: 'x', reKey: { passphrase: 'new-pw' },
      }),
    ).rejects.toThrow(/liberate|custody/)
  })

  it('(c) custodian cannot extractPartition', async () => {
    const comp = await custodianDb.openVault(COMP)
    await expect(
      extractPartition(comp, { seeds: { invoices: () => true } }),
    ).rejects.toThrow(/owner|custodian/)
  })

  it('control: the owner CAN rotate / extract (no regression)', async () => {
    const comp = await ownerDb.openVault(COMP)
    await expect(ownerDb.rotate(COMP, ['invoices'])).resolves.not.toThrow()
    await expect(
      extractPartition(comp, { seeds: { invoices: () => true } }),
    ).resolves.toBeTruthy()
  })

  it('control: an admin CAN rotate (no regression)', async () => {
    await ownerDb.grant(COMP, { userId: 'admin-01', displayName: 'Admin', role: 'admin', passphrase: 'admin-pass' })
    const adminDb = await createNoydb({ store: adapter, user: 'admin-01', secret: 'admin-pass' })
    await adminDb.openVault(COMP)
    await expect(adminDb.rotate(COMP, ['invoices'])).resolves.not.toThrow()
  })
})

describe('FR-6 built-in gates: grant-custodian / liberate-vault', () => {
  // Mirror the `client-unilateral-withdraw` fail-closed contract: a built-in
  // gate with no configured policy is DENIED ('disabled'); it only passes once
  // the host opts in with `{ enabled: true, minTier: 1 }`.
  const EMPTY_POLICY = { gates: {} } as const

  for (const gate of ['grant-custodian', 'liberate-vault'] as const) {
    it(`${gate}: fails closed by default (no policy)`, async () => {
      let err: unknown
      try {
        await checkGate(EMPTY_POLICY, gate, { activeTier: 1 })
      } catch (e) { err = e }
      expect(err).toBeInstanceOf(PolicyDeniedError)
      if (err instanceof PolicyDeniedError) expect(err.reason).toBe('disabled')
    })

    it(`${gate}: passes when enabled`, async () => {
      const policy = { gates: { [gate]: { enabled: true, minTier: 1 as const } } }
      await expect(
        checkGate(policy, gate, { activeTier: 1 }),
      ).resolves.toBeUndefined()
    })
  }
})
