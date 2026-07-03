/**
 * FR-6 Task 5 — `liberateVault`: the audited claim of ownership over a
 * sealed-owner (Deed) vault. The inverse of #199 withdrawal.
 *
 * The **custodian** is the de-facto authority: it holds every collection DEK
 * and operates the vault fully, but it can never reach `KEK_owner` (sealed
 * under a non-firm provider). Liberation is the ONLY way a custodian assumes
 * ownership — and it does so under an audited ceremony:
 *
 *   1. gate `'liberate-vault'` (fail-closed)
 *   2. caller MUST be the `custodian`
 *   3. freeze a PRE-liberation EVIDENCE snapshot (hash-pinned) — but the live
 *      data is PRESERVED for the new owner (liberation transfers operational
 *      continuity; it does NOT erase)
 *   4. mint a NEW owner keyring re-wrapping the incumbent DEKs under the new
 *      owner's KEK (the old sealed owner is NOT unsealed — the inalienability
 *      floor is preserved; the new owner is a DISTINCT principal and the old
 *      sealed-owner credential is orphaned, never impersonated)
 *   5. lifecycle ledger `liberation-claimed:<newOwnerId>:<legalBasis>`
 *   6. stamp `_meta/deed` marker `liberatedAt`
 *
 * FREEZE-vs-SNAPSHOT-ONLY DECISION (see liberate.ts + the plan §"Task 5"):
 * `freezeAndDeleteClosure` (withdraw-accessible.ts) writes the hash-pinned
 * snapshot then DELETES the live records. That is correct for a destructive
 * withdrawal but WRONG for liberation, which must leave the live data intact
 * for the new owner. We factored a snapshot-only helper `freezeSnapshotOnly`
 * out of that module (the existing freeze-AND-delete path is unchanged); the
 * test below asserts the live records SURVIVE the ceremony.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, PermissionDeniedError } from '../src/kernel/errors.js'
import { PolicyDeniedError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import type { Noydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { saveDeedMarker, loadDeedMarker } from '../src/with-party/team/deed.js'
import { liberateVault } from '../src/with-party/custody/liberate.js'
import { withCustody } from '../src/with-party/custody/index.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function bucket(v: string, c: string) {
    let m = store.get(v); if (!m) { m = new Map(); store.set(v, m) }
    let b = m.get(c); if (!b) { b = new Map(); m.set(c, b) }
    return b
  }
  return {
    async get(v, c, id) { return bucket(v, c).get(id) ?? null },
    async put(v, c, id, env, ev) { const b = bucket(v, c); const ex = b.get(id); if (ev !== undefined && (ex?._v ?? 0) !== ev) throw new ConflictError(ex?._v ?? 0); b.set(id, env) },
    async delete(v, c, id) { bucket(v, c).delete(id) },
    async list(v, c) { return [...bucket(v, c).keys()] },
    async loadAll(v) { const m = store.get(v); const s: VaultSnapshot = {}; if (m) for (const [n, c] of m) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of c) r[id] = e; s[n] = r } } return s },
    async saveAll(v, data) { for (const [n, recs] of Object.entries(data)) { const b = bucket(v, n); for (const [id, e] of Object.entries(recs)) b.set(id, e) } },
  }
}

interface Invoice { amount: number; status: string }

const VAULT = 'C500'
// `liberate-vault` is the fail-closed gate that authorises the ceremony.
// `grant-custodian` is enabled so the owner can mint the custodian first.
const POLICY = {
  gates: {
    'liberate-vault': { enabled: true, minTier: 1 },
    'grant-custodian': { enabled: true, minTier: 1 },
  },
}

describe('FR-6 Task 5 — liberateVault (audited custodian ownership claim)', () => {
  let adapter: NoydbStore
  let ownerDb: Noydb

  /**
   * Provision a Deed-flavoured vault (owner + a plaintext `_meta/deed` marker)
   * with the history strategy enabled (so the lifecycle ledger is live), seed
   * two collections, then grant a custodian.
   */
  async function provisionWithCustodian(policy: unknown = POLICY): Promise<void> {
    // @ts-expect-error — policy is typed as unknown in this test helper; the spread resolves correctly at runtime
    ownerDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass', historyStrategy: withHistory(), custodyStrategy: withCustody(), ...(policy ? { policy } : {}) })
    const comp = await ownerDb.openVault(VAULT)
    await comp.collection<Invoice>('invoices').put('inv-001', { amount: 5000, status: 'draft' })
    await comp.collection<Invoice>('payments').put('pay-001', { amount: 3000, status: 'paid' })
    // Stamp a Deed marker so liberation has a marker to update with `liberatedAt`.
    await saveDeedMarker(adapter, VAULT, {
      ownerUserId: 'owner-01', sealedUnder: 'client-kms', latent: true, issuedAt: new Date().toISOString(),
    })
    await ownerDb.grantCustodian(VAULT, { userId: 'firm-01', displayName: 'Firm', passphrase: 'firm-pass-long' })
  }

  beforeEach(() => {
    adapter = inlineMemory()
  })

  it('custodian liberates: snapshot pinned, ledger audited, live data preserved, new owner operates', async () => {
    await provisionWithCustodian()

    // The custodian opens + claims ownership.
    const firmDb = await createNoydb({ store: adapter, user: 'firm-01', secret: 'firm-pass-long', historyStrategy: withHistory() })
    const custodianVault = await firmDb.openVault(VAULT)

    const result = await liberateVault(custodianVault, {
      newOwnerId: 'firm-owner-01',
      newOwnerPassphrase: 'firm-owner-pass-long',
      legalBasis: 'contractual-handover',
    })

    // 1. evidence snapshot returned with a 64-hex sha256.
    expect(result.snapshot.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.snapshot.recordCount).toBeGreaterThan(0)
    expect(typeof result.snapshot.frozenAt).toBe('string')

    // 2. lifecycle ledger carries the liberation-claimed entry.
    const entries = await custodianVault.ledger().entries()
    const claimed = entries.filter(e => e.reason === 'liberation-claimed:firm-owner-01:contractual-handover')
    expect(claimed).toHaveLength(1)

    // 3. LIVE data is PRESERVED (liberation transfers continuity; it does NOT erase).
    expect((await custodianVault.collection<Invoice>('invoices').get('inv-001'))?.amount).toBe(5000)
    expect((await custodianVault.collection<Invoice>('payments').get('pay-001'))?.amount).toBe(3000)

    // 4. the NEW owner is a DISTINCT principal who can open + operate as owner.
    const newOwnerDb = await createNoydb({ store: adapter, user: 'firm-owner-01', secret: 'firm-owner-pass-long' })
    const newOwnerVault = await newOwnerDb.openVault(VAULT)
    expect((await newOwnerVault.collection<Invoice>('invoices').get('inv-001'))?.amount).toBe(5000)
    await expect(
      newOwnerVault.collection<Invoice>('invoices').put('inv-002', { amount: 1, status: 'new' }),
    ).resolves.not.toThrow()
    // The new owner can perform an owner-only meta-capability (grant) → proves owner role.
    await expect(
      newOwnerDb.grant(VAULT, { userId: 'staff-01', displayName: 'Staff', role: 'viewer', passphrase: 'staff-pass-long', permissions: { invoices: 'ro' } }),
    ).resolves.not.toThrow()

    // 5. the OLD sealed-owner credential is ORPHANED, not impersonated — the new
    //    owner keyring is a separate `_keyring/<id>` file under a fresh KEK; the
    //    original owner-01 keyring is untouched and still present.
    expect(await adapter.get(VAULT, '_keyring', 'owner-01')).not.toBeNull()
    expect(await adapter.get(VAULT, '_keyring', 'firm-owner-01')).not.toBeNull()

    // 6. the Deed marker now records `liberatedAt`.
    const marker = await loadDeedMarker(adapter, VAULT)
    expect(typeof marker?.liberatedAt).toBe('string')
  })

  it('throws when the `liberate-vault` gate is disabled (fail-closed)', async () => {
    // No policy → the `liberate-vault` built-in gate is unconfigured → fail-closed.
    await provisionWithCustodian({ gates: { 'grant-custodian': { enabled: true, minTier: 1 } } })
    const firmDb = await createNoydb({ store: adapter, user: 'firm-01', secret: 'firm-pass-long', historyStrategy: withHistory() })
    const custodianVault = await firmDb.openVault(VAULT)
    await expect(
      liberateVault(custodianVault, { newOwnerId: 'firm-owner-01', newOwnerPassphrase: 'firm-owner-pass-long', legalBasis: 'contractual-handover' }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  it('throws when the caller is NOT the custodian (owner tries)', async () => {
    await provisionWithCustodian()
    // The owner opens the vault and tries to liberate — only the custodian may.
    const ownerVault = await ownerDb.openVault(VAULT)
    await expect(
      liberateVault(ownerVault, { newOwnerId: 'firm-owner-01', newOwnerPassphrase: 'firm-owner-pass-long', legalBasis: 'contractual-handover' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('throws when the caller is an operator (not the custodian)', async () => {
    await provisionWithCustodian()
    await ownerDb.grant(VAULT, { userId: 'op-01', displayName: 'Op', role: 'operator', passphrase: 'op-pass-long', permissions: { invoices: 'rw' } })
    const opDb = await createNoydb({ store: adapter, user: 'op-01', secret: 'op-pass-long', historyStrategy: withHistory() })
    const opVault = await opDb.openVault(VAULT)
    await expect(
      liberateVault(opVault, { newOwnerId: 'firm-owner-01', newOwnerPassphrase: 'firm-owner-pass-long', legalBasis: 'contractual-handover' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('refuses to clobber an existing principal: newOwnerId must be a fresh id', async () => {
    await provisionWithCustodian()
    const firmDb = await createNoydb({ store: adapter, user: 'firm-01', secret: 'firm-pass-long', historyStrategy: withHistory() })
    const custodianVault = await firmDb.openVault(VAULT)
    // capture the existing owner-01 keyring envelope before the attempt
    const before = await adapter.get(VAULT, '_keyring', 'owner-01')
    // newOwnerId collides with the existing sealed owner → must throw, no clobber.
    await expect(
      liberateVault(custodianVault, { newOwnerId: 'owner-01', newOwnerPassphrase: 'whatever-long-pass', legalBasis: 'contractual-handover' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
    // the original keyring is byte-identical (not overwritten) and no liberation ledger entry was written.
    expect(await adapter.get(VAULT, '_keyring', 'owner-01')).toEqual(before)
    const entries = await custodianVault.ledger().entries()
    expect(entries.filter(e => e.reason?.startsWith('liberation-claimed:'))).toHaveLength(0)
  })
})
