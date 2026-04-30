/**
 * Showcase 60 — Storage: Cloudflare R2 (real-service, credentialed)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-cloudflare-r2` is a thin wrapper over the AWS S3 SDK
 * pointed at the R2 endpoint `https://<accountId>.r2.cloudflarestorage.com`.
 * The on-disk and on-the-wire layouts are S3-compatible, so the store
 * delegates to `@noy-db/to-aws-s3` after building the right `S3Client`.
 * That means: the conformance contract, key scheme
 * (`{prefix}/{vault}/{collection}/{id}.json`), and zero-knowledge
 * invariant from showcase 57 all transfer to R2 unchanged — only the
 * authentication surface is different.
 *
 * Why it matters
 * ──────────────
 * R2 is the "S3 with no egress fees" backup destination. NOYDB encrypts
 * before the first byte hits the network, so even Cloudflare staff with
 * full bucket read access learn nothing about your records — they see
 * AES-256-GCM ciphertext + envelope metadata (`_v`, `_ts`). For an
 * adopter on a tight egress budget who already trusts AWS for primary
 * record storage but wants a cheap blob mirror, `routeStore({ blobs:
 * r2(...), default: dynamo(...) })` is a one-line topology change away
 * from the showcase 59 setup.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 57 (the AWS S3 sibling — same contract).
 * - Real Cloudflare R2:
 *     - `NOYDB_SHOWCASE_R2_ACCOUNT_ID` (Cloudflare dashboard sidebar)
 *     - `NOYDB_SHOWCASE_R2_ACCESS_KEY_ID`
 *     - `NOYDB_SHOWCASE_R2_SECRET_ACCESS_KEY`
 *     - `NOYDB_SHOWCASE_R2_BUCKET` (optional — defaults to
 *       `noydb-showcase-r2`; create the bucket in the dashboard first)
 *
 * Skipped cleanly when those aren't present. The skip-hint line tells
 * the developer exactly which keys to fill in.
 *
 * What to read next
 * ─────────────────
 *   - showcase 57-storage-aws-s3 (the parent S3 implementation)
 *   - docs/packages/stores.md → "to-cloudflare-r2"
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-cloudflare-r2
 */

import { afterAll, describe, expect, it } from 'vitest'
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { createNoydb } from '@noy-db/hub'
import { r2, r2EndpointFor } from '@noy-db/to-cloudflare-r2'
import { envGate, logSkipHint, R2_GATE_VARS, R2_DEFAULT_BUCKET } from './_env.js'

const gate = envGate({ label: 'to-cloudflare-r2', vars: R2_GATE_VARS })
logSkipHint('to-cloudflare-r2 (showcase 60)', gate, R2_GATE_VARS)

interface Note { id: string; text: string }

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const VAULT_NAME = `showcase-60-${RUN_ID}`
const PREFIX = `noy-db-showcase-60/${RUN_ID}`

describe.skipIf(!gate.enabled)('Showcase 60 — Storage: Cloudflare R2 (real-service, credentialed)', () => {
  const accountId = gate.values['NOYDB_SHOWCASE_R2_ACCOUNT_ID']!
  const accessKeyId = gate.values['NOYDB_SHOWCASE_R2_ACCESS_KEY_ID']!
  const secretAccessKey = gate.values['NOYDB_SHOWCASE_R2_SECRET_ACCESS_KEY']!
  const bucket = process.env['NOYDB_SHOWCASE_R2_BUCKET'] || R2_DEFAULT_BUCKET

  // Direct S3 client for raw spot-checks. R2 requires path-style addressing
  // and a region of 'auto'; the package handles those internally for the
  // store, but the spot-check client needs the same config explicitly.
  const rawClient = new S3Client({
    region: 'auto',
    endpoint: r2EndpointFor(accountId),
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  })

  afterAll(async () => {
    try {
      const listed = await rawClient.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX }),
      )
      for (const obj of listed.Contents ?? []) {
        if (!obj.Key) continue
        await rawClient
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }))
          .catch(() => {})
      }
    } catch (err) {
      const code = (err as { name?: string }).name ?? 'unknown'
      // eslint-disable-next-line no-console
      console.warn(
        `[to-cloudflare-r2] afterAll cleanup skipped (${code}). If the test failed for the same reason — most likely a missing or unreachable bucket "${bucket}" — fix the bucket and re-run.`,
      )
    }
  })

  it('round-trips records through a real R2 bucket', async () => {
    const store = r2({ accountId, accessKeyId, secretAccessKey, bucket, prefix: PREFIX })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-r2-passphrase-2026',
    })
    const vault = await db.openVault(VAULT_NAME)
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'in r2' })
    await notes.put('b', { id: 'b', text: 'still in r2' })

    expect(await notes.get('a')).toEqual({ id: 'a', text: 'in r2' })
    expect((await notes.list()).map((r) => r.id).sort()).toEqual(['a', 'b'])
    db.close()
  })

  it('R2 sees only ciphertext — bodies do not leak the plaintext sentinel', async () => {
    const store = r2({ accountId, accessKeyId, secretAccessKey, bucket, prefix: PREFIX })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-r2-zk-passphrase-2026',
    })
    const vault = await db.openVault(`${VAULT_NAME}-zk`)
    await vault
      .collection<Note>('secrets')
      .put('top', { id: 'top', text: 'plaintext-needle-R2-PQR' })
    db.close()

    const listed = await rawClient.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX }),
    )
    expect(listed.Contents?.length).toBeGreaterThan(0)

    for (const obj of listed.Contents ?? []) {
      if (!obj.Key) continue
      const got = await rawClient.send(
        new GetObjectCommand({ Bucket: bucket, Key: obj.Key }),
      )
      const body = await got.Body!.transformToString()
      expect(body).not.toContain('plaintext-needle-R2-PQR')
    }
  })
})

if (gate.enabled) {
  // eslint-disable-next-line no-console
  console.info(
    `[to-cloudflare-r2] Using account=${process.env['NOYDB_SHOWCASE_R2_ACCOUNT_ID']?.slice(0, 8)}… bucket=${process.env['NOYDB_SHOWCASE_R2_BUCKET'] || R2_DEFAULT_BUCKET} prefix=${PREFIX}`,
  )
}
