/**
 * Showcase 35 — as-zip (composite records + attachments)
 *
 * What you'll learn
 * ─────────────────
 * `toBytes(vault, { records: { collection } })` packages a collection's
 * decrypted records into a single zip archive — pure-JS encoder, STORE
 * method (no compression deps). Pair with `attachments` to bundle blobs
 * fetched via the blobs subsystem.
 *
 * Why it matters
 * ──────────────
 * "Send me everything for client X" — a single archive makes that
 * one-click. The package is dep-free so the bundle stays tiny on
 * client-side builds.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 32-as-csv (the export-capability gate).
 *
 * What to read next
 * ─────────────────
 *   - showcase 36-as-noydb (encrypted bundle export)
 *   - docs/subsystems/exports.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → exports → as-zip
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { toBytes } from '@noy-db/as-zip'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; amount: number }

describe('Showcase 35 — as-zip', () => {
  it('packages decrypted records into a valid zip archive', async () => {
    const store = memory()
    // as-zip's records-only path still queries the blob slot for any
    // attached binaries — enable the blobs strategy so the call resolves.
    const db = await createNoydb({ store, user: 'alice', secret: 'as-zip-pass-2026', blobStrategy: withBlobs() })
    const vault = await db.openVault('demo')
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', amount: 100 })

    await db.grant('demo', {
      userId: 'alice', displayName: 'Alice', role: 'owner',
      passphrase: 'as-zip-pass-2026',
      exportCapability: { plaintext: ['zip'] },
    })
    db.close()

    const db2 = await createNoydb({ store, user: 'alice', secret: 'as-zip-pass-2026', blobStrategy: withBlobs() })
    const v2 = await db2.openVault('demo')

    const bytes = await toBytes(v2, { records: { collection: 'invoices' } })
    // First two bytes of every zip are 'PK' (0x504b).
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    expect(bytes.byteLength).toBeGreaterThan(50)
    db2.close()
  })
})
