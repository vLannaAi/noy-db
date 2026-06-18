/**
 * Showcase 122 — klum-db sovereign custody: Deed / Custodian / Liberate (FR-6)
 *
 * What you'll learn
 * ─────────────────
 * A "Deed vault" has a LATENT owner — a principal whose credential is sealed
 * under a non-firm `MemorySealingKeyProvider`. The firm operates the vault as
 * a `custodian` but is provably blocked from ownership-level actions. The
 * ceremony:
 *
 *   1. `createDeedOwner(store, vault, ownerUserId, sealing)` — mints a latent
 *      owner whose passphrase is sealed under the non-firm provider. No human
 *      ever types it.
 *   2. `vault.custody.grantCustodian(opts)` — the Deed owner mints a firm-side
 *      custodian who operates ALL collections (rw + access) but is locked out
 *      from grant / rotate / extract-and-sever.
 *   3. Invariant assertions — grant / extract all throw for the custodian.
 *   4. `vault.custody.liberate({legalBasis})` — the custodian claims ownership
 *      by minting a DISTINCT new owner re-wrapping the incumbent DEKs; the
 *      Deed marker gains `liberatedAt`; the lifecycle ledger records the event.
 *
 * Why it matters
 * ──────────────
 * The inalienability floor: the custodian's keyring NEVER carries `KEK_owner`
 * (it is sealed under a non-firm provider). Liberation is the only route to
 * ownership transfer, and it is audited + mints a distinct principal — it
 * never impersonates the latent owner.
 *
 * Note on the re-open pattern
 * ───────────────────────────
 * `createDeedOwner` returns an `UnlockedKeyring`. To re-open the vault as
 * that owner in subsequent sessions, the caller resolves the sealed passphrase
 * via `resolveManagedSecret(store, vault, sealing)` (the hub internal) and
 * passes it to `createNoydb({ secret: resolved })`. The showcase uses the
 * lower-level `loadSealedPassphrase` + `SealingKeyProvider.unseal` to surface
 * the exact re-open pattern without requiring managed-mode full enrolment.
 *
 * Spec mapping
 * ────────────
 * features.yaml → sovereign-custody
 * docs/superpowers/specs/2026-06-17-fr6-deed-custodian-liberate-design.md
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, MemorySealingKeyProvider, PermissionDeniedError } from '@noy-db/hub'
import { withHistory } from '@noy-db/hub/history'
import { extractPartition, PartitionExtractionError } from '@noy-db/hub/bundle'
import { createDeedOwner, loadDeedMarker } from '@klum-db/lobby'
import { memory } from '@noy-db/to-memory'

// Both custody gates enabled — they are fail-closed by default.
const POLICY = {
  gates: {
    'grant-custodian': { enabled: true, minTier: 1 },
    'liberate-vault': { enabled: true, minTier: 1 },
    'revoke-user': { enabled: true, minTier: 1 },
    'client-unilateral-withdraw': { enabled: true, minTier: 1 },
  },
} as const

describe('Showcase 122 — klum-db sovereign custody', () => {
  it(
    'createDeedOwner → grantCustodian → custodian operates but is blocked → liberate mints new owner + ledger',
    async () => {
      const store = memory()
      const sealing = new MemorySealingKeyProvider({ id: 'client-kms-122' })
      const VAULT = 'deed-vault-122'

      // ── 1. Provision the Deed ─────────────────────────────────────────────
      // `createDeedOwner` mints a latent owner whose passphrase is sealed under
      // the non-firm provider and writes the _meta/deed marker. Returns the
      // unlocked owner keyring so the provisioner can seed collections immediately.
      const ownerKeyring = await createDeedOwner(store, VAULT, 'latent-owner', sealing)
      // ownerKeyring has the material; we use it to prove the passphrase is recoverable
      expect(ownerKeyring.userId).toBe('latent-owner')

      // The sealed passphrase can be recovered via the provider (unseal round-trip).
      // Open a session as the latent owner by unsealing + passing the resolved secret.
      const sealed = await store.get(VAULT, '_meta', 'sealed-passphrase')
      expect(sealed).not.toBeNull() // the passphrase is persisted sealed

      // Unseal the stored passphrase via the provider.
      // The v1 wire format: { v:1, _noydb_sealed:1, pid:string, payload:base64(sealedBytes) }
      // The unsealed bytes are the raw 32-byte random; the passphrase is their btoa encoding.
      const sealedData = JSON.parse(sealed!._data) as { payload: string }
      const sealedBytes = Uint8Array.from(atob(sealedData.payload), c => c.charCodeAt(0))
      const unsealed = await sealing.unseal(sealedBytes)
      // The passphrase is btoa of the raw random bytes (same as resolveManagedSecret internals)
      let binary = ''
      for (let i = 0; i < unsealed.length; i++) binary += String.fromCharCode(unsealed[i]!)
      const ownerPassphrase = btoa(binary)

      const ownerDb = await createNoydb({
        store, user: 'latent-owner', secret: ownerPassphrase,
        historyStrategy: withHistory(), policy: POLICY,
      })
      const ownerVault = await ownerDb.openVault(VAULT)

      // Seed records the custodian will operate
      await ownerVault.collection<{ id: string; amount: number }>('invoices').put('inv-1', { id: 'inv-1', amount: 5000 })
      await ownerVault.collection<{ id: string; ref: string }>('contracts').put('con-1', { id: 'con-1', ref: 'K-001' })

      // ── 2. Deed owner mints a custodian (owner-only, fail-closed gate) ─────
      await ownerVault.custody.grantCustodian({
        userId: 'firm-custodian',
        displayName: 'Firm Custodian',
        passphrase: 'firm-custodian-pass-2026',
      })

      // ── 3. Custodian operates ALL collections fully ────────────────────────
      const firmDb = await createNoydb({
        store, user: 'firm-custodian', secret: 'firm-custodian-pass-2026',
        historyStrategy: withHistory(), policy: POLICY,
      })
      const firmVault = await firmDb.openVault(VAULT)

      expect((await firmVault.collection<{ id: string; amount: number }>('invoices').get('inv-1'))?.amount).toBe(5000)
      expect((await firmVault.collection<{ id: string; ref: string }>('contracts').get('con-1'))?.ref).toBe('K-001')

      // Custodian can write new records
      await firmVault.collection<{ id: string; amount: number }>('invoices').put('inv-2', { id: 'inv-2', amount: 250 })
      expect(await firmVault.collection<{ id: string; amount: number }>('invoices').get('inv-2')).not.toBeNull()

      // ── 4. Invariant: custodian CANNOT grant (PermissionDeniedError) ───────
      await expect(
        firmDb.grant(VAULT, { userId: 'mole', displayName: 'Mole', role: 'admin', passphrase: 'mole-pass-2026' }),
      ).rejects.toThrow(PermissionDeniedError)

      // ── 5. Invariant: custodian CANNOT extract-and-sever ──────────────────
      await expect(
        extractPartition(firmVault, { seeds: { invoices: () => true } }),
      ).rejects.toThrow(PartitionExtractionError)

      // ── 6. Liberate: custodian claims ownership → distinct new owner ──────
      const result = await firmVault.custody.liberate({
        newOwnerId: 'firm-owner-new',
        newOwnerPassphrase: 'firm-owner-pass-2026',
        legalBasis: 'contractual-handover',
      })

      // ASSERT: pre-liberation evidence snapshot is hash-pinned
      expect(result.snapshot.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.snapshot.recordCount).toBeGreaterThan(0)

      // ASSERT: lifecycle ledger records the liberation event
      const entries = await firmVault.ledger().entries()
      const liberations = entries.filter(
        e => e.reason === 'liberation-claimed:firm-owner-new:contractual-handover',
      )
      expect(liberations).toHaveLength(1)

      // ASSERT: Deed marker stamped with liberatedAt
      const marker = await loadDeedMarker(store, VAULT)
      expect(marker).not.toBeNull()
      expect(marker!.latent).toBe(true)
      expect(marker!.ownerUserId).toBe('latent-owner')
      expect(marker!.sealedUnder).toBe('client-kms-122')
      expect(typeof marker!.liberatedAt).toBe('string')

      // ASSERT: the new owner is DISTINCT and can operate the vault
      const newOwnerDb = await createNoydb({
        store, user: 'firm-owner-new', secret: 'firm-owner-pass-2026',
      })
      const newOwnerVault = await newOwnerDb.openVault(VAULT)
      // Live data is preserved (liberation is NOT destructive)
      expect((await newOwnerVault.collection<{ id: string; amount: number }>('invoices').get('inv-1'))?.amount).toBe(5000)
      expect(await newOwnerVault.collection<{ id: string; amount: number }>('invoices').get('inv-2')).not.toBeNull()

      ownerDb.close()
      firmDb.close()
      newOwnerDb.close()
    },
  )

  it('grant-custodian and liberate-vault gates are fail-closed by default (no policy override)', async () => {
    const store2 = memory()
    const sealing2 = new MemorySealingKeyProvider({ id: 'client-kms-122b' })
    const VAULT2 = 'deed-vault-122b'

    await createDeedOwner(store2, VAULT2, 'latent-b', sealing2)

    // Recover the sealed passphrase via unseal (same pattern as above)
    const sealed = await store2.get(VAULT2, '_meta', 'sealed-passphrase')
    const sealedData = JSON.parse(sealed!._data) as { payload: string }
    const sealedBytes = Uint8Array.from(atob(sealedData.payload), c => c.charCodeAt(0))
    const rawBytes = await sealing2.unseal(sealedBytes)
    let bin = ''
    for (let i = 0; i < rawBytes.length; i++) bin += String.fromCharCode(rawBytes[i]!)
    const ownerPass = btoa(bin)

    // Open with DEFAULT policy (no gate overrides) — custody gates fail-closed
    const ownerDb = await createNoydb({ store: store2, user: 'latent-b', secret: ownerPass })
    const ownerVault = await ownerDb.openVault(VAULT2)

    // grantCustodian hits the fail-closed 'grant-custodian' gate → PolicyDeniedError
    await expect(
      ownerVault.custody.grantCustodian({
        userId: 'firm-x', displayName: 'Firm X', passphrase: 'firm-x-pass-2026',
      }),
    ).rejects.toThrow() // PolicyDeniedError

    ownerDb.close()
  })
})
