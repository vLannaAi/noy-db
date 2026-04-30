/**
 * Showcase 32 — as-csv (plaintext export)
 *
 * What you'll learn
 * ─────────────────
 * `toString(vault, { collection })` decrypts a single collection and
 * formats it as RFC-4180 CSV. The call is gated by the keyring's
 * `exportCapability.plaintext` — without an explicit grant
 * `ExportCapabilityError` is thrown before any decryption happens.
 *
 * Why it matters
 * ──────────────
 * This is the egress contract: plaintext leaves the encrypted boundary
 * only when the keyring carries an explicit format-scoped grant. Even
 * the owner has no implicit plaintext capability (RFC #249).
 *
 * Prerequisites
 * ─────────────
 * - Showcase 06-multi-user (grants).
 *
 * What to read next
 * ─────────────────
 *   - showcase 33-as-xlsx (multi-sheet Excel export)
 *   - docs/subsystems/exports.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → exports → as-csv
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, ExportCapabilityError } from '@noy-db/hub'
import { toString } from '@noy-db/as-csv'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; client: string; amount: number }

describe('Showcase 32 — as-csv', () => {
  it('owner with csv grant produces RFC-4180 CSV', async () => {
    const store = memory()

    const db = await createNoydb({ store, user: 'alice', secret: 'as-csv-pass-2026' })
    const vault = await db.openVault('demo')
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', client: 'Globex', amount: 1500 })
    await vault.collection<Invoice>('invoices').put('b', { id: 'b', client: 'Acme, Inc.', amount: 2400 })

    // Self-grant the plaintext-csv capability — owner has no implicit grant.
    await db.grant('demo', {
      userId: 'alice', displayName: 'Alice', role: 'owner',
      passphrase: 'as-csv-pass-2026',
      exportCapability: { plaintext: ['csv'] },
    })
    db.close()

    const db2 = await createNoydb({ store, user: 'alice', secret: 'as-csv-pass-2026' })
    const v2 = await db2.openVault('demo')
    const csv = await toString(v2, { collection: 'invoices' })

    expect(csv.split('\n')[0]).toMatch(/^id,client,amount$/)
    expect(csv).toContain('a,Globex,1500')
    // Field with comma is RFC-4180 quoted.
    expect(csv).toContain('"Acme, Inc."')
    db2.close()
  })

  it('owner without grant is refused with ExportCapabilityError', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: 'as-csv-pass-2026' })
    const vault = await db.openVault('demo')
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', client: 'X', amount: 1 })

    await expect(toString(vault, { collection: 'invoices' })).rejects.toBeInstanceOf(ExportCapabilityError)
    db.close()
  })
})
