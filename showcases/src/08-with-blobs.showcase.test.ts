/**
 * Showcase 08 — withBlobs()
 *
 * What you'll learn
 * ─────────────────
 * `withBlobs()` adds binary attachments to records. Each record can
 * carry one or more "slots" — `collection.blob(id).put('avatar',
 * bytes)` — encrypted in 256 KB chunks with AES-GCM and AAD-bound
 * metadata. Identical content across records dedups via a HMAC-keyed
 * eTag.
 *
 * Why it matters
 * ──────────────
 * Records are typically small (~KB); binary content is the long tail.
 * The blob subsystem stays out of the floor bundle when not opted in
 * (~2,400 LOC saved); when on, it provides the contract you'd write
 * by hand if you cared about chunked encryption + dedup.
 *
 * Prerequisites
 * ─────────────
 * - Showcases 00 + 01 + 07.
 *
 * What to read next
 * ─────────────────
 *   - showcase 16-as-zip (composite export with blobs)
 *   - docs/subsystems/blobs.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → blobs
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { memory } from '@noy-db/to-memory'

interface Profile { id: string; name: string }

describe('Showcase 08 — withBlobs()', () => {
  it('attaches a binary blob to a record and round-trips it', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-blobs-passphrase-2026',
      blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('demo')
    const profiles = vault.collection<Profile>('profiles')
    await profiles.put('p1', { id: 'p1', name: 'Alice' })

    const avatar = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]) // JPEG magic + filler
    await profiles.blob('p1').put('avatar', avatar, { mimeType: 'image/jpeg' })

    const got = await profiles.blob('p1').get('avatar')
    expect(got).not.toBeNull()
    expect(Array.from(got!)).toEqual(Array.from(avatar))

    const slots = await profiles.blob('p1').list()
    expect(slots).toHaveLength(1)
    expect(slots[0]!.name).toBe('avatar')
    expect(slots[0]!.mimeType).toBe('image/jpeg')

    db.close()
  })

  it('without withBlobs() opted in, collection.blob() throws', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-blobs-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    const profiles = vault.collection<Profile>('profiles')
    expect(() => profiles.blob('p1')).toThrow(/blob/)
    db.close()
  })
})
