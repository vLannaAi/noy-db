/**
 * Showcase 100 — erasable blobs (per-blob CEK crypto-shred)
 *
 * What you'll learn
 * ─────────────────
 * On a `perRecordKeys` collection (or any collection declared in
 * `withForgetCascade`), each blob attachment is encrypted under its own
 * per-blob **content CEK** — a key wrapped under the vault `_blob` DEK and
 * stored on the blob index entry. `vault.forget(subject)` then crypto-shreds
 * that subject's blobs: when the last reference drops, the index entry (the
 * sole copy of the wrapped content CEK) is deleted, so the chunks become
 * permanently undecryptable — a key-delete, not a bulk-byte wipe.
 *
 * Why it matters
 * ──────────────
 * GDPR erasure has to reach attachments, not just record bodies. Doing it
 * cryptographically (delete a ~40-byte key) makes erasure instant and durable
 * even on object stores that don't truly delete bytes — the same guarantee the
 * record tombstone gives the record body, now one level down for blobs.
 *
 * The honest edge: content-addressed dedup means identical bytes shared by two
 * subjects are ONE physical copy. Forgetting one subject can't destroy the
 * other's data — so a shared blob is *retained* until its last owner is
 * forgotten, then shredded. `forget()` reports this distinctly.
 *
 * Prerequisites
 * ─────────────
 * - Showcases 00 + 08 (with-blobs).
 *
 * What to read next
 * ─────────────────
 *   - docs/superpowers/specs/2026-06-13-per-blob-cek-design.md
 *   - features.yaml → features → per-blob-cek / forget-cascade
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → per-blob-cek
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { withHistory } from '@noy-db/hub/history'
import { withForgetCascade } from '@noy-db/hub/forget'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; buyerId: string }

const text = (s: string) => new TextEncoder().encode(s)

describe('Showcase 100 — erasable blobs (per-blob CEK)', () => {
  it('forget() crypto-shreds a subject-exclusive blob attachment', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'clerk',
      secret: 'erasable-blobs-passphrase-2026',
      blobStrategy: withBlobs(),
      historyStrategy: withHistory(), // forget() needs the ledger
      // Declaring the subject forces perRecordKeys on `invoices`, so its
      // blobs are erasable.
      forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
    })
    const vault = await db.openVault('acme')
    const invoices = vault.collection<Invoice>('invoices')

    await invoices.put('inv-1', { id: 'inv-1', buyerId: 'buyer-1' })
    await invoices.blob('inv-1').put('contract.pdf', text('buyer-1 personal data'))

    // The blob round-trips while the subject exists.
    const before = await invoices.blob('inv-1').get('contract.pdf')
    expect(new TextDecoder().decode(before!)).toBe('buyer-1 personal data')

    // Right to erasure: forget the subject → the blob is crypto-shredded.
    const result = await vault.forget('buyer-1')
    expect(result.blobsShredded).toBe(1)
    expect(result.blobResidueCollections).toEqual([]) // no un-erasable residue

    // The attachment is gone — its content CEK was the only way to read it.
    expect(await invoices.blob('inv-1').get('contract.pdf')).toBeNull()

    db.close()
  })

  it('shared content is retained for its other owner, then shredded at the last reference', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'clerk',
      secret: 'erasable-blobs-passphrase-2026',
      blobStrategy: withBlobs(),
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
    })
    const vault = await db.openVault('acme')
    const invoices = vault.collection<Invoice>('invoices')

    // Two subjects, one identical attachment → deduped to a single chunk set.
    await invoices.put('inv-1', { id: 'inv-1', buyerId: 'buyer-1' })
    await invoices.put('inv-2', { id: 'inv-2', buyerId: 'buyer-2' })
    const shared = text('jointly-held agreement.pdf')
    await invoices.blob('inv-1').put('agreement.pdf', shared)
    await invoices.blob('inv-2').put('agreement.pdf', shared)

    // Forget buyer-1: the bytes are still buyer-2's, so they are RETAINED.
    const r1 = await vault.forget('buyer-1')
    expect(r1.blobsRetainedShared).toBe(1)
    expect(r1.blobsShredded).toBe(0)
    expect(new TextDecoder().decode((await invoices.blob('inv-2').get('agreement.pdf'))!))
      .toBe('jointly-held agreement.pdf')

    // Forget buyer-2 (the last owner) → now it is crypto-shredded.
    const r2 = await vault.forget('buyer-2')
    expect(r2.blobsShredded).toBe(1)
    expect(await invoices.blob('inv-2').get('agreement.pdf')).toBeNull()

    db.close()
  })
})
