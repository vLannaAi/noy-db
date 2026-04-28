/**
 * Showcase 57 — Storage: AWS S3 (real-service, credentialed)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-aws-s3` lays records out as one S3 object per record:
 * `{prefix}/{vault}/{collection}/{id}.json`. Each PUT writes a single
 * encrypted envelope; LIST is a `ListObjectsV2` over the prefix. The
 * adapter has `casAtomic: false` because S3 has no native compare-
 * and-swap — for a casAtomic cloud store, pair S3 with DynamoDB via
 * `routeStore` (see showcase 05).
 *
 * Why it matters
 * ──────────────
 * S3 is the canonical "cheap, durable, eventually consistent" backup
 * destination. NOYDB encrypts before the first byte hits the network,
 * so even an attacker with full bucket read access learns *only*
 * envelope metadata (`_v`, `_ts`) — the schema and contents are
 * AES-256-GCM-encrypted. This makes S3 a safe destination for the
 * *backup* role even on accounts you don't fully trust.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 04 (`to-aws-dynamo` mocked baseline).
 * - Showcase 04b would be the real-AWS DynamoDB equivalent — use the
 *   same `NOYDB_SHOWCASE_AWS_PROFILE` to run both.
 * - This showcase requires:
 *     `NOYDB_SHOWCASE_AWS_PROFILE` (in showcases/.env)
 *     `NOYDB_SHOWCASE_S3_BUCKET` (default: 'noydb-showcase-blobs')
 *
 * Skipped cleanly when the env vars aren't set. The skip-hint line in
 * the test report tells the developer exactly what to fill in.
 *
 * What to read next
 * ─────────────────
 *   - showcase 04-storage-cloud (DynamoDB single-table, mocked)
 *   - showcase 05-storage-routing (route blobs to S3, records to Dynamo)
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-aws-s3
 */

import { afterAll, describe, expect, it } from 'vitest'
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { createNoydb } from '@noy-db/hub'
import { s3 } from '@noy-db/to-aws-s3'
import { AWS_ENABLED, AWS_PROFILE, S3_BUCKET, AWS_CLEANUP, RUN_ID, logSkipHint } from './_aws.js'

logSkipHint('to-aws-s3 (showcase 57)')

interface Note { id: string; text: string }

const VAULT_NAME = `showcase-57-${RUN_ID}`
const PREFIX = `noy-db-showcase-57/${RUN_ID}`

describe.skipIf(!AWS_ENABLED)('Showcase 57 — Storage: AWS S3 (real-service, credentialed)', () => {
  // The AWS SDK default chain reads AWS_PROFILE (set by _setup.ts) and
  // resolves region + credentials from ~/.aws/config + ~/.aws/credentials.
  const client = new S3Client({})

  afterAll(async () => {
    if (!AWS_CLEANUP) return
    // Delete every object the test created so the bucket doesn't accrue
    // throwaway data. Best-effort — one stuck list/delete shouldn't make
    // the test report louder than it needs to be.
    try {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: PREFIX }),
      )
      for (const obj of listed.Contents ?? []) {
        if (!obj.Key) continue
        await client
          .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }))
          .catch(() => {})
      }
    } catch (err) {
      const code = (err as { name?: string }).name ?? 'unknown'
      // eslint-disable-next-line no-console
      console.warn(
        `[to-aws-s3] afterAll cleanup skipped (${code}). If the test itself failed for the same reason — most likely a missing or unreachable bucket "${S3_BUCKET}" — fix the bucket and re-run.`,
      )
    }
  })

  it('round-trips records through a real S3 bucket', async () => {
    const store = s3({ bucket: S3_BUCKET, prefix: PREFIX, client })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-s3-passphrase-2026',
    })
    const vault = await db.openVault(VAULT_NAME)
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'in s3' })
    await notes.put('b', { id: 'b', text: 'still in s3' })

    expect(await notes.get('a')).toEqual({ id: 'a', text: 'in s3' })
    expect((await notes.list()).map((r) => r.id).sort()).toEqual(['a', 'b'])
    db.close()
  })

  it('S3 sees only ciphertext — vault and collection names appear in the keyspace, but bodies do not leak', async () => {
    const store = s3({ bucket: S3_BUCKET, prefix: PREFIX, client })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-s3-zk-passphrase-2026',
    })
    const vault = await db.openVault(`${VAULT_NAME}-zk`)
    await vault.collection<Note>('secrets').put('top', { id: 'top', text: 'plaintext-needle-XYZ' })
    db.close()

    // Fetch every object the writer produced and confirm the plaintext
    // string never appears in any of them — only AES-GCM ciphertext +
    // unencrypted metadata (_v, _ts, _iv) lands in S3.
    const listed = await client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: PREFIX }))
    expect(listed.Contents?.length).toBeGreaterThan(0)

    // The keyspace LEAKS structure (vault/collection/id are part of the
    // S3 key) — that's by design; the adapter doesn't claim to obfuscate
    // keys. What matters is that bodies don't leak.
    const ourKeys = (listed.Contents ?? []).map((o) => o.Key ?? '')
    expect(ourKeys.some((k) => k.includes(`${VAULT_NAME}-zk`))).toBe(true)
    expect(ourKeys.some((k) => k.includes('secrets'))).toBe(true)

    // Pull every object's body and assert no plaintext leaked.
    for (const obj of listed.Contents ?? []) {
      if (!obj.Key) continue
      const got = await client
        .send(new (await import('@aws-sdk/client-s3')).GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }))
      const body = await got.Body!.transformToString()
      expect(body).not.toContain('plaintext-needle-XYZ')
    }
  })
})

// Surface which profile is in use when the gate opens — helps debugging
// "wrong account" issues without printing credentials.
if (AWS_ENABLED) {
  // eslint-disable-next-line no-console
  console.info(`[to-aws-s3] Using AWS_PROFILE=${AWS_PROFILE} bucket=${S3_BUCKET} prefix=${PREFIX}`)
}
