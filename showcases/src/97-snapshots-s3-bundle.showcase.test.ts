/**
 * Showcase 97 — Snapshots over a real S3 bundle store (real-service, credentialed)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-aws-s3` ships `s3Bundle()` — a `NoydbBundleStore` for whole-vault
 * `.noydb` blobs (distinct from the per-record `s3()` adapter). It is the
 * destination for `withSnapshots({ store: s3Bundle(...) })`. This showcase
 * exercises it against a real S3 bucket:
 *   1. write/read round-trip (key scheme `{prefix}/{vaultId}.noydb`, ETag version);
 *   2. optimistic concurrency — a stale `IfMatch` write is rejected with
 *      `BundleVersionConflictError` (real S3 412, not a mock);
 *   3. a full snapshot lifecycle (checkpoint → list → restore) over S3.
 *
 * Why it matters
 * ──────────────
 * The unit tests prove the adapter's logic against a fake S3; only a real
 * bucket proves S3 conditional writes (`IfMatch`) actually enforce OCC the way
 * the snapshot index relies on. NOYDB encrypts before the first byte hits the
 * network — an attacker with full bucket read learns only envelope metadata.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 57 (to-aws-s3 per-record, real-service) — same AWS profile.
 * - Showcase 93/96 (snapshots: on-demand + auto-cadence).
 * - Requires `NOYDB_SHOWCASE_AWS_PROFILE` + `NOYDB_SHOWCASE_S3_BUCKET` in
 *   `showcases/.env`. Skipped cleanly when unset.
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → with-snapshots ; adapters → to-aws-s3
 */
import { afterAll, describe, expect, it } from 'vitest'
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { createNoydb, BundleVersionConflictError } from '@noy-db/hub'
import { withSnapshots } from '@noy-db/hub/snapshots'
import { s3Bundle } from '@noy-db/to-aws-s3'
import { memory } from '@noy-db/to-memory'
import { AWS_ENABLED, S3_BUCKET, AWS_CLEANUP, RUN_ID, logSkipHint } from './_aws.js'

logSkipHint('to-aws-s3 s3Bundle (showcase 97)')

const PREFIX = `noy-db-showcase-97/${RUN_ID}`
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

describe.skipIf(!AWS_ENABLED)('Showcase 97 — snapshots over real S3 bundle store', () => {
  // Default credential chain reads AWS_PROFILE (set by _setup.ts) → region + creds.
  const client = new S3Client({})
  const store = s3Bundle({ bucket: S3_BUCKET, prefix: PREFIX, client })

  afterAll(async () => {
    if (!AWS_CLEANUP) {
      // eslint-disable-next-line no-console
      console.info(`[showcase 97] AWS_CLEANUP=0 — leaving objects under ${PREFIX} in place.`)
      return
    }
    try {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: PREFIX }))
      for (const obj of listed.Contents ?? []) {
        if (obj.Key) await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key })).catch(() => {})
      }
    } catch {
      /* best effort */
    }
  })

  it('writes and reads a bundle round-trip with an ETag version token', async () => {
    const w = await store.writeBundle('rt__vault', enc('hello-s3'), null)
    expect(w.version).toBeTruthy()
    const r = await store.readBundle('rt__vault')
    expect(r).not.toBeNull()
    expect(dec(r!.bytes)).toBe('hello-s3')
    expect(r!.version).toBe(w.version)
  })

  it('returns null for a missing bundle', async () => {
    expect(await store.readBundle('does-not-exist')).toBeNull()
  })

  it('enforces OCC — a stale IfMatch write is rejected by real S3 (412)', async () => {
    const w1 = await store.writeBundle('occ__vault', enc('one'), null)
    await store.writeBundle('occ__vault', enc('two'), null) // advances the ETag
    await expect(
      store.writeBundle('occ__vault', enc('three'), w1.version),
    ).rejects.toThrow(BundleVersionConflictError)
  })

  it('lists bundles with metadata from a single ListObjectsV2 (no per-object GET)', async () => {
    await store.writeBundle('list__a', enc('aaa'), null)
    await store.writeBundle('list__b', enc('bbbb'), null)
    const list = await store.listBundles()
    const ids = list.map(x => x.vaultId)
    expect(ids).toContain('list__a')
    expect(ids).toContain('list__b')
    const b = list.find(x => x.vaultId === 'list__b')!
    expect(b.size).toBe(enc('bbbb').length)
    expect(b.version).toBeTruthy()
  })

  it('runs a full snapshot lifecycle (checkpoint → list → restore) over S3', async () => {
    const db = await createNoydb({
      store: memory(), user: 'acct', secret: 'pw-97',
      snapshotStrategy: withSnapshots({ store }),
    })
    const vault = await db.openVault('s3snap')
    const entries = vault.collection<{ id: string; amount: number }>('entries')
    await entries.put('e1', { id: 'e1', amount: 100 })

    const snap = await db.snapshot('s3snap', { label: 'checkpoint-1' })
    expect(snap.integrity).toBe('verified')

    const list = await db.listSnapshots('s3snap')
    expect(list.find(s => s.label === 'checkpoint-1')).toBeDefined()

    // Mutate, then restore the checkpoint — the snapshot bytes round-trip through S3.
    await entries.put('e2', { id: 'e2', amount: 999 })
    await expect(db.restoreSnapshot('s3snap', snap.version)).resolves.toBeUndefined()
    db.close()
  })
})
