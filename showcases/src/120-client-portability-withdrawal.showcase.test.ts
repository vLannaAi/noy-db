/**
 * Showcase 120 — Client-initiated portability + withdrawal (#199)
 *
 * What you'll learn
 * ─────────────────
 * A non-owner principal (an `operator` with `rw` scope) can act on THEIR OWN
 * accessible data, three ways, all via `vault.user.*`:
 *
 *   1. `exportMyAccessibleData()` — conservative, non-destructive, always
 *      allowed. Walks the caller's accessible collections, re-keys the bundle
 *      to a passphrase they choose, and audits the egress. Nothing is removed.
 *   2. `unilateralWithdrawal({ disposition: 'delete' })` — export-and-erase
 *      (GDPR Art. 17). The re-keyed copy is produced FIRST, then the live
 *      records leave the vault entirely (delete-closure).
 *   3. `unilateralWithdrawal({ disposition: 'freeze' })` — export, then the
 *      firm KEEPS a cryptographically-frozen, write-once, hash-pinned snapshot
 *      of the original ciphertext while the live records are removed. For
 *      regulated retention: the client departs with their copy; the firm holds
 *      an immutable, provably-unaltered point-in-time record.
 *
 * Why it matters
 * ──────────────
 * The cryptographic invariant: the caller holds the DEKs for their scope, so
 * *export* is a capability, not a permission — the firm can audit and gate, but
 * cannot prevent it. *Withdrawal* is destructive, so it is fail-closed behind
 * the built-in `client-unilateral-withdraw` gate (disabled by default); the
 * firm opts in per jurisdiction/contract. Read-only roles (`client`/`viewer`)
 * cannot self-serve a deletion — they route to the two-party `requestWithdrawal`.
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → client-portability
 * docs/superpowers/specs/2026-06-16-client-initiated-portability-withdrawal-design.md
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { readNoydbBundle } from '@noy-db/hub/bundle'
import { memory } from '@noy-db/to-memory'

interface Invoice extends Record<string, unknown> { id: string; total: number }

/**
 * Firm vault owned by the director, with operator "belle" granted rw on
 * `invoices`. `enableWithdraw` flips the otherwise default-off destructive gate.
 */
async function firmVault(store: ReturnType<typeof memory>, enableWithdraw: boolean) {
  const policy = enableWithdraw
    ? ({ gates: { 'client-unilateral-withdraw': { enabled: true, minTier: 1 } } } as const)
    : undefined
  const director = await createNoydb({ store, user: 'alice', secret: 'alice-director-2026', ...(policy ? { policy } : {}) })
  const ov = await director.openVault('firm')
  await ov.collection<Invoice>('invoices').put('i1', { id: 'i1', total: 1000 })
  await ov.collection<Invoice>('invoices').put('i2', { id: 'i2', total: 500 })
  await director.grant('firm', {
    userId: 'belle', displayName: 'Belle', role: 'operator', passphrase: 'belle-operator-2026',
    permissions: { invoices: 'rw' },
  })
  director.close()
  const op = await createNoydb({ store, user: 'belle', secret: 'belle-operator-2026' })
  return op.openVault('firm')
}

describe('Showcase 120 — client portability + withdrawal', () => {
  it('exportMyAccessibleData re-keys the caller scope and leaves the source intact', async () => {
    const vault = await firmVault(memory(), false)

    const bytes = await vault.user.exportMyAccessibleData({ reKey: { passphrase: 'belle-takeaway-pass' } })
    const dump = JSON.parse((await readNoydbBundle(bytes)).dumpJson) as { collections?: Record<string, unknown> }
    expect(Object.keys(dump.collections ?? {})).toContain('invoices')

    // Non-destructive: the records are still live in the firm vault.
    expect(await vault.collection<Invoice>('invoices').get('i1')).not.toBeNull()
  })

  it('the destructive withdrawal is fail-closed unless the firm opts in', async () => {
    const vault = await firmVault(memory(), false) // gate disabled (default)
    await expect(
      vault.user.unilateralWithdrawal({ legalBasis: 'gdpr-art-17', reKey: { passphrase: 'x-pass' } }),
    ).rejects.toThrow() // PolicyDeniedError — points the caller at requestWithdrawal
  })

  it('disposition:delete exports then erases the live records (GDPR Art. 17)', async () => {
    const vault = await firmVault(memory(), true)

    const { bundle, snapshot } = await vault.user.unilateralWithdrawal({
      disposition: 'delete', legalBasis: 'gdpr-art-17', reKey: { passphrase: 'belle-takeaway-pass' },
    })
    expect(snapshot).toBeUndefined()
    const dump = JSON.parse((await readNoydbBundle(bundle)).dumpJson) as { collections?: Record<string, unknown> }
    expect(Object.keys(dump.collections ?? {})).toContain('invoices')

    // Live records are gone.
    expect(await vault.collection<Invoice>('invoices').get('i1')).toBeNull()
    expect(await vault.collection<Invoice>('invoices').get('i2')).toBeNull()
  })

  it('disposition:freeze keeps a hash-pinned write-once snapshot, removes the live records', async () => {
    const store = memory()
    const vault = await firmVault(store, true)

    const { snapshot } = await vault.user.unilateralWithdrawal({
      disposition: 'freeze', legalBasis: 'regulated-retention', reKey: { passphrase: 'belle-takeaway-pass' },
    })
    expect(snapshot).toBeTruthy()
    expect(snapshot!.recordCount).toBe(2)
    expect(snapshot!.sha256).toMatch(/^[0-9a-f]{64}$/) // tamper-evident hash pinned in the ledger

    // The frozen snapshot lives in the reserved write-once namespace; the firm
    // can reopen it with the keys it already holds.
    const frozen = await store.get('firm', '_frozen_snapshots', snapshot!.withdrawalId)
    expect(frozen).not.toBeNull()

    // Live records removed.
    expect(await vault.collection<Invoice>('invoices').get('i1')).toBeNull()
  })
})
