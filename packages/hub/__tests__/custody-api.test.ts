/**
 * FR-6 Task 6 — `vault.custody.*` surface: the END-TO-END acceptance walkthrough.
 *
 * This exercises the whole FR-6 ceremony through the public `vault.custody.*`
 * namespace (mirroring `vault.user.*`) rather than the low-level functions:
 *
 *   1. Provision a Deed vault (latent owner sealed under a non-firm
 *      `MemorySealingKeyProvider`) with records + the `grant-custodian` /
 *      `liberate-vault` gates enabled.
 *   2. The Deed owner mints a custodian via `vault.custody.grantCustodian(...)`.
 *      The firm (custodian) opens + reads/writes ALL collections, but is
 *      provably UNABLE to grant / rotate / sever / extract (spot-checked
 *      denials — invariant #1).
 *   3. The owner — re-resolved through the SAME sealing provider (a latent
 *      owner never types a passphrase) — `vault.custody.revokeCustodian(...)`
 *      AND `extractPartition(...)` succeed with the custodian "offline" (we
 *      simply never use the custodian keyring) — invariant #2.
 *   4. A custodian claims ownership via `vault.custody.liberate(...)`, minting
 *      a new owner under an audited event. The shared lifecycle ledger shows
 *      BOTH a prior withdrawal-style entry AND the liberation entry — the two
 *      events share the one `vault.ledger()` mechanism (invariant #3).
 *
 * Inalienability (#4) is cryptographic: the custodian's keyring never carries
 * `KEK_owner` (sealed under the non-firm provider), proven structurally — the
 * custodian cannot extract/sever, and liberation mints a DISTINCT new owner
 * rather than impersonating the latent one.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, PermissionDeniedError, ReadOnlyError, PartitionExtractionError } from '../src/errors.js'
import { extractPartition } from '../src/with-share/bundle/extract-partition.js'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { MemorySealingKeyProvider, resolveManagedSecret } from '../src/with-party/team/managed-passphrase.js'
import { createDeedOwner, loadDeedMarker } from '../src/with-party/team/deed.js'

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

interface Invoice { id: string; amount: number; status: string }

const VAULT = 'C600'
// Both custody gates enabled; `revoke-user` (used by revokeCustodian) + the
// `client-unilateral-withdraw` gate (used to stage the prior withdrawal entry).
const POLICY = {
  gates: {
    'grant-custodian': { enabled: true, minTier: 1 as const },
    'liberate-vault': { enabled: true, minTier: 1 as const },
    'revoke-user': { enabled: true, minTier: 1 as const },
    'client-unilateral-withdraw': { enabled: true, minTier: 1 as const },
  },
}

describe('FR-6 Task 6 — vault.custody.* end-to-end acceptance walkthrough', () => {
  let adapter: NoydbStore
  let sealing: MemorySealingKeyProvider

  beforeEach(() => {
    adapter = inlineMemory()
    sealing = new MemorySealingKeyProvider({ id: 'client-kms' })
  })

  /**
   * Re-resolve the latent Deed owner as a working `Noydb`. The owner credential
   * was minted + sealed under the non-firm provider by `createDeedOwner`; here
   * we UNSEAL it through the SAME provider (`resolveManagedSecret`) and hand the
   * resolved passphrase to `createNoydb` as the secret. NO HUMAN ever types it —
   * the sealing provider is the only re-entry point — which is exactly the
   * latent-owner property. (We resolve-then-pass rather than using
   * `passphraseMode: 'managed'` so the acceptance walkthrough stays focused on
   * custody and isn't entangled with managed-mode's strong-recovery enrolment
   * gate, which is a separate epic.)
   */
  async function openLatentOwner(): Promise<Noydb> {
    const passphrase = await resolveManagedSecret(adapter, VAULT, sealing)
    return createNoydb({
      store: adapter, user: 'owner-01', secret: passphrase,
      historyStrategy: withHistory(), policy: POLICY,
    })
  }

  /**
   * Provision a Deed vault: a latent owner sealed under the non-firm provider
   * + the `_meta/deed` marker, with the history strategy live (so the lifecycle
   * ledger records the ceremony) and three seeded collections.
   */
  async function provisionDeed(): Promise<Noydb> {
    // Mint the sealed owner + marker (machine-side, no human passphrase).
    await createDeedOwner(adapter, VAULT, 'owner-01', sealing)
    const ownerDb = await openLatentOwner()
    const comp = await ownerDb.openVault(VAULT)
    await comp.collection<Invoice>('invoices').put('inv-001', { id: 'inv-001', amount: 5000, status: 'draft' })
    await comp.collection<Invoice>('payments').put('pay-001', { id: 'pay-001', amount: 3000, status: 'paid' })
    await comp.collection<Invoice>('archive').put('arc-001', { id: 'arc-001', amount: 99, status: 'old' })
    return ownerDb
  }

  it('full acceptance: grant → custodian operates + is denied → owner revokes/extracts offline → liberate (ledger shows withdrawal + liberation)', async () => {
    const ownerDb = await provisionDeed()
    const ownerVault = await ownerDb.openVault(VAULT)

    // ── 1. Owner grants a custodian through vault.custody.grantCustodian ──────
    await expect(
      ownerVault.custody.grantCustodian({ userId: 'firm-01', displayName: 'Firm', passphrase: 'firm-pass-long' }),
    ).resolves.not.toThrow()

    // ── 2. The custodian opens + reads/writes ALL collections ────────────────
    const firmDb = await createNoydb({ store: adapter, user: 'firm-01', secret: 'firm-pass-long', historyStrategy: withHistory(), policy: POLICY })
    const firmVault = await firmDb.openVault(VAULT)
    expect((await firmVault.collection<Invoice>('invoices').get('inv-001'))?.amount).toBe(5000)
    expect((await firmVault.collection<Invoice>('payments').get('pay-001'))?.amount).toBe(3000)
    await expect(firmVault.collection<Invoice>('invoices').put('inv-002', { id: 'inv-002', amount: 1000, status: 'new' })).resolves.not.toThrow()
    await expect(firmVault.collection<Invoice>('payments').put('pay-002', { id: 'pay-002', amount: 7, status: 'x' })).resolves.not.toThrow()

    // ── 2b. The custodian is PROVABLY UNABLE to grant / rotate / sever / extract
    // grant (via db.grant — the keyring boundary): denied.
    await expect(
      firmDb.grant(VAULT, { userId: 'mole-01', displayName: 'Mole', role: 'admin', passphrase: 'mole-pass-long' }),
    ).rejects.toThrow(PermissionDeniedError)
    // rotate: denied (re-key is an owner meta-capability).
    await expect(firmDb.rotate(VAULT, [])).rejects.toThrow(PermissionDeniedError)
    // destructive sever via vault.user.unilateralWithdrawal: denied (must liberate).
    await expect(
      firmVault.user.unilateralWithdrawal({ legalBasis: 'sneaky-sever' }),
    ).rejects.toThrow(ReadOnlyError)
    // extract-and-sever via extractPartition: denied (owner-only).
    await expect(
      extractPartition(firmVault, { seeds: { invoices: () => true } }),
    ).rejects.toThrow(PartitionExtractionError)

    // ── 3. Owner re-resolved via the sealing provider (no interactive
    //       passphrase) revokes the custodian + extracts — custodian OFFLINE.
    //       (We simply never touch firmDb / the custodian keyring here.)
    const latentOwnerDb = await openLatentOwner()
    const latentOwnerVault = await latentOwnerDb.openVault(VAULT)
    await expect(
      latentOwnerVault.custody.revokeCustodian({ userId: 'firm-01' }),
    ).resolves.not.toThrow()
    // After revocation the firm keyring is gone — a fresh custodian open is denied.
    const firmAfter = await createNoydb({ store: adapter, user: 'firm-01', secret: 'firm-pass-long' })
    await expect(firmAfter.openVault(VAULT)).rejects.toThrow()
    // The latent owner can extract-and-sever WITHOUT the custodian's cooperation.
    const extracted = await extractPartition(latentOwnerVault, { seeds: { invoices: () => true } })
    expect(extracted.bundleBytes.byteLength).toBeGreaterThan(0)
    expect(extracted.transferKey.byteLength).toBe(32)
  })

  it('liberation: custodian claims ownership; ledger shows BOTH a prior withdrawal-style entry AND the liberation entry (shared mechanism)', async () => {
    const ownerDb = await provisionDeed()
    const ownerVault = await ownerDb.openVault(VAULT)

    // Stage a PRIOR withdrawal-style lifecycle entry: an operator self-serves a
    // (non-destructive freeze) unilateral withdrawal over the `archive`
    // collection — this writes a `user-unilateral-withdrawal:...` entry into the
    // SAME `vault.ledger()` the liberation later appends to.
    await ownerDb.grant(VAULT, { userId: 'op-01', displayName: 'Op', role: 'operator', passphrase: 'op-pass-long', permissions: { archive: 'rw' } })
    const opDb = await createNoydb({ store: adapter, user: 'op-01', secret: 'op-pass-long', historyStrategy: withHistory(), policy: POLICY })
    const opVault = await opDb.openVault(VAULT)
    await opVault.user.unilateralWithdrawal({ legalBasis: 'partial-handover', disposition: 'freeze', scope: { collections: ['archive'] } })

    // Now mint the custodian + liberate via vault.custody.liberate.
    await ownerVault.custody.grantCustodian({ userId: 'firm-01', displayName: 'Firm', passphrase: 'firm-pass-long' })
    const firmDb = await createNoydb({ store: adapter, user: 'firm-01', secret: 'firm-pass-long', historyStrategy: withHistory(), policy: POLICY })
    const firmVault = await firmDb.openVault(VAULT)

    const result = await firmVault.custody.liberate({
      newOwnerId: 'firm-owner-01', newOwnerPassphrase: 'firm-owner-pass-long', legalBasis: 'contractual-handover',
    })
    expect(result.snapshot.sha256).toMatch(/^[0-9a-f]{64}$/)

    // The ONE shared lifecycle ledger carries BOTH lifecycle events.
    const entries = await firmVault.ledger().entries()
    const withdrawals = entries.filter(e => typeof e.reason === 'string' && e.reason.startsWith('user-unilateral-withdrawal:'))
    const liberations = entries.filter(e => e.reason === 'liberation-claimed:firm-owner-01:contractual-handover')
    expect(withdrawals.length).toBeGreaterThanOrEqual(1)
    expect(liberations).toHaveLength(1)

    // The new owner is a DISTINCT principal who can operate as owner; live data preserved.
    const newOwnerDb = await createNoydb({ store: adapter, user: 'firm-owner-01', secret: 'firm-owner-pass-long' })
    const newOwnerVault = await newOwnerDb.openVault(VAULT)
    expect((await newOwnerVault.collection<Invoice>('invoices').get('inv-001'))?.amount).toBe(5000)

    // The Deed marker records `liberatedAt`.
    const marker = await loadDeedMarker(adapter, VAULT)
    expect(typeof marker?.liberatedAt).toBe('string')
  })

  it('vault.custody.grantCustodian is owner-only (an admin caller is denied)', async () => {
    const ownerDb = await provisionDeed()
    await ownerDb.grant(VAULT, { userId: 'admin-01', displayName: 'Admin', role: 'admin', passphrase: 'admin-pass-long' })
    const adminDb = await createNoydb({ store: adapter, user: 'admin-01', secret: 'admin-pass-long', policy: POLICY })
    const adminVault = await adminDb.openVault(VAULT)
    await expect(
      adminVault.custody.grantCustodian({ userId: 'firm-99', displayName: 'Firm', passphrase: 'firm-pass-long' }),
    ).rejects.toThrow(PermissionDeniedError)
  })

  it('vault.custody.liberate is denied to a non-custodian (owner caller)', async () => {
    const ownerDb = await provisionDeed()
    const ownerVault = await ownerDb.openVault(VAULT)
    await expect(
      ownerVault.custody.liberate({ newOwnerId: 'x', newOwnerPassphrase: 'x-pass-long', legalBasis: 'nope' }),
    ).rejects.toThrow(PermissionDeniedError)
  })
})
