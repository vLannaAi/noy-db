/**
 * Showcase 21 — Bundle (.noydb container format)
 *
 * What you'll learn
 * ─────────────────
 * `writeNoydbBundle(vault)` serializes a vault into a `.noydb`
 * binary container (10-byte magic prefix + JSON header + compressed
 * body). `readNoydbBundle(bytes)` parses it back, verifying the
 * integrity hash before returning the dump JSON. Pair with
 * `vault.load(json)` for restore.
 *
 * Why it matters
 * ──────────────
 * Bundles are the safe-cloud-drop format: a single self-describing
 * file that anyone can copy without leaking handle metadata. The
 * ULID-based handle in the header lets a sync engine reconcile
 * versions without parsing the body.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 01.
 * - Showcase 07 if you want a verifiable-integrity backup (history
 *   strategy embeds the ledger head).
 *
 * What to read next
 * ─────────────────
 *   - docs/subsystems/bundle.md (full container format)
 *   - the @noy-db/to-file saveBundle/loadBundle helpers
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → bundle
 *
 * Note: bundle is always-core today. Subpath import is
 * `@noy-db/hub/bundle` for tree-shake-friendly access; the same
 * symbols are also re-exported from `@noy-db/hub`.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { writeNoydbBundle, readNoydbBundle, NOYDB_BUNDLE_MAGIC } from '@noy-db/hub/bundle'
import { withHistory } from '@noy-db/hub/history'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 21 — Bundle (.noydb)', () => {
  it('writes a verifiable bundle and reads it back', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-bundle-passphrase-2026',
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('demo')
    await vault.collection<Note>('notes').put('a', { id: 'a', text: 'in the bundle' })

    const bytes = await writeNoydbBundle(vault)
    // First 4 bytes match the NDB1 magic.
    expect(Array.from(bytes.slice(0, NOYDB_BUNDLE_MAGIC.byteLength))).toEqual(
      Array.from(NOYDB_BUNDLE_MAGIC),
    )
    expect(bytes.byteLength).toBeGreaterThan(20)

    const result = await readNoydbBundle(bytes)
    expect(result.header).toBeDefined()
    expect(result.header.handle).toBeDefined()
    expect(typeof result.dumpJson).toBe('string')
    expect(result.dumpJson).toContain('"_compartment":"demo"')

    db.close()
  })

  it('the bundle integrity hash detects body tampering', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-bundle-passphrase-2026',
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('demo')
    await vault.collection<Note>('notes').put('a', { id: 'a', text: 'baseline' })

    const bytes = await writeNoydbBundle(vault)

    // Flip a byte in the body region (after the 10-byte prefix +
    // header). Reading the tampered bundle should throw because the
    // body's sha256 no longer matches the header's bodySha256.
    const tampered = new Uint8Array(bytes)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! + 1) % 256

    await expect(readNoydbBundle(tampered)).rejects.toThrow()

    db.close()
  })
})
