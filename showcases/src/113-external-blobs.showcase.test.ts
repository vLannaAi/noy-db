/**
 * Showcase 113 — external (direct-serve) blob fields (#412)
 *
 * What you'll learn
 * ─────────────────
 * A blob field declared `external` stores its bytes in the vault's
 * **ObjectProjection** (`createNoydb({ objectStore })`) as a single, raw,
 * **unencrypted** object — servable straight from S3/CDN and processable by
 * native tooling (e.g. AWS MediaConvert on a video) — instead of the encrypted
 * chunk path. Meanwhile:
 *   1. The **record stays encrypted**, and so does the blob's **slot record** —
 *      which remains the catalog (the *anchoring invariant*: you enumerate via
 *      the collection, never by listing the bucket).
 *   2. `blob(id).url(field)` returns a URL (presigned or public) to the object.
 *   3. Non-`external` fields keep using the zero-knowledge encrypted chunks.
 *
 * Here we use `memoryObjectProjection()` so the showcase runs offline. In
 * production swap it for the real S3 projection:
 *
 *   import { asAwsS3 } from '@noy-db/as-aws-s3'
 *   const db = await createNoydb({ store, user, secret,
 *     objectStore: asAwsS3({ bucket: 'acme-assets', region: 'eu-west-1' }),
 *     blobStrategy: withBlobs() })
 *
 * Why it matters
 * ──────────────
 * Some attachments (a 1 GB video, a public logo) need to live as real,
 * directly-servable objects — not encrypted chunks only the hub can read. This
 * keeps the vault as the encrypted **catalog** while the bytes live where AWS
 * can stream/transcode them. The bytes are **outside** the zero-knowledge
 * guarantee — opt in per field, deliberately.
 *
 * What to read next
 * ─────────────────
 *   - docs/services/blobs.md
 *   - docs/superpowers/specs/2026-06-15-as-aws-s3-direct-serve-blobs-design.md
 *
 * Spec mapping
 * ────────────
 *   #412 — direct-serve blobs (P3: hub wiring to an ObjectProjection)
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, memoryObjectProjection } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { memory } from '@noy-db/to-memory'

describe('showcase 113 — external (direct-serve) blob fields', () => {
  it('routes external bytes to the projection; record + slot stay the encrypted catalog', async () => {
    const objects = memoryObjectProjection({ baseUrl: 'https://cdn.example.com' })
    const db = await createNoydb({
      store: memory(),
      user: 'op',
      secret: 'pw-113-long-enough',
      objectStore: objects, // ← swap for asAwsS3({ bucket }) in production
      blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('media')
    const clips = vault.collection<{ id: string; title: string }>('clips', {
      blobFields: {
        video: { external: true, public: true }, // → ObjectProjection (servable)
        poster: {}, // → encrypted chunks (zero-knowledge)
      },
    })
    await clips.put('c1', { id: 'c1', title: 'Launch' })

    const bytes = new Uint8Array(4096).map((_, i) => (i * 17) & 0xff)
    await clips.blob('c1').put('video', bytes, { mimeType: 'video/mp4' })

    // The object is in the projection, addressable + servable by URL.
    expect(Buffer.from((await clips.blob('c1').get('video'))!).equals(Buffer.from(bytes))).toBe(true)
    expect(await clips.blob('c1').url('video')).toBe('https://cdn.example.com/clips/c1/video')

    // The slot record (in the encrypted collection) is the catalog entry.
    const slot = (await clips.blob('c1').list()).find((s) => s.name === 'video')!
    expect(slot.external?.key).toBe('clips/c1/video')

    // Encrypted record is unaffected.
    expect(await clips.get('c1')).toEqual({ id: 'c1', title: 'Launch' })
  })
})
