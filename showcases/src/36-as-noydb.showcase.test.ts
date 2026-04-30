/**
 * Showcase 36 — as-noydb (encrypted .noydb bundle)
 *
 * What you'll learn
 * ─────────────────
 * `toBytes(vault)` produces an encrypted `.noydb` bundle (the
 * always-core container format from showcase 21). Unlike the plaintext
 * `as-*` siblings, this exporter is gated by `canExportBundle`, which
 * defaults to `true` for owner/admin and `false` for every other role.
 *
 * Why it matters
 * ──────────────
 * Bundles are the "safe cloud drop" format: the bytes are inert without
 * the KEK, so an admin can publish them to any blob store, send them
 * over email, or hand them on a USB stick — the recipient still needs
 * the original passphrase to read anything.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 21-with-bundle (the bundle format).
 *
 * What to read next
 * ─────────────────
 *   - docs/subsystems/exports.md
 *   - docs/subsystems/bundle.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → exports → as-noydb
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { NOYDB_BUNDLE_MAGIC } from '@noy-db/hub/bundle'
import { toBytes, peek } from '@noy-db/as-noydb'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 36 — as-noydb (encrypted bundle)', () => {
  it('owner produces a valid .noydb bundle with NDB1 magic + handle', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: 'as-noydb-pass-2026' })
    const vault = await db.openVault('demo')
    await vault.collection<Note>('notes').put('a', { id: 'a', text: 'sealed' })

    // Owner has bundle capability by default — no grant call required.
    const bytes = await toBytes(vault)

    expect(Array.from(bytes.slice(0, NOYDB_BUNDLE_MAGIC.byteLength))).toEqual(
      Array.from(NOYDB_BUNDLE_MAGIC),
    )
    const header = peek(bytes)
    expect(header.handle).toBeDefined()
    expect(header.bodyBytes).toBeGreaterThan(0)

    db.close()
  })
})
