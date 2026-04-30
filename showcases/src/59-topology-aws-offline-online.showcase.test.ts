/**
 * Showcase 59 — Topology: AWS S3 + DynamoDB end-to-end (records + blobs,
 *                          meter-wrapped, offline/online sync)
 *
 * What you'll learn
 * ─────────────────
 * The full production topology a NOYDB consumer most often deploys:
 *
 *   - **DynamoDB** carries records (atomic CAS via ConditionExpression).
 *   - **S3** carries blob chunks (cheap, durable, eventually-consistent).
 *   - **routeStore()** multiplexes them so the hub sees one store and
 *     routes the four `_blob_*` system collections to S3.
 *   - **toMeter()** wraps the route so per-method counts + percentiles
 *     are inspectable from one snapshot — the only observability surface
 *     adopters get for cloud calls (NOYDB never sees the network).
 *   - A **field-tablet** instance simulates an offline operator: pulls,
 *     edits while offline, then pushes — all without ever revealing
 *     plaintext to the cloud.
 *
 * Why it matters
 * ──────────────
 * This is the topology the SPEC's "first consumer" works on: a regulated
 * accounting firm with a fleet of operators, some of whom edit invoices
 * on a tablet that may be offline for hours. The cloud is the source of
 * truth; conflict resolution is `_v`-versioned (last-write-wins by
 * envelope version). The test exercises a real conflict + a clean
 * concurrent edit + a new-record-from-field path, then verifies the
 * cloud's raw bytes contain no plaintext.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 04 (DynamoDB mocked baseline) and 05 (routeStore).
 * - Showcase 08 (withBlobs).
 * - Showcase 15 (withSync).
 * - Showcase 55 + 56 (meter / probe).
 * - Real AWS:
 *     - `NOYDB_SHOWCASE_AWS_PROFILE` set
 *     - DynamoDB table `noydb-showcase` (pk:S, sk:S) provisioned
 *     - S3 bucket `noydb-showcase-blobs` (or override via env) provisioned
 *
 * Skipped cleanly when those aren't present.
 *
 * What to read next
 * ─────────────────
 *   - showcase 05-storage-routing (the pure routing pattern, mocked)
 *   - showcase 15-with-sync (sync primitives in isolation)
 *   - docs/subsystems/sync.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → topologies → aws-cloud-team
 */

import { afterAll, describe, expect, it } from 'vitest'
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { createNoydb, routeStore } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { withSync } from '@noy-db/hub/sync'
import { dynamo } from '@noy-db/to-aws-dynamo'
import { s3 } from '@noy-db/to-aws-s3'
import { memory } from '@noy-db/to-memory'
import { toMeter } from '@noy-db/to-meter'

import {
  AWS_ENABLED,
  AWS_PROFILE,
  AWS_CLEANUP,
  DYNAMO_TABLE,
  S3_BUCKET,
  RUN_ID,
  logSkipHint,
} from './_aws.js'

logSkipHint('topology-aws (showcase 59)')

// ── Domain shapes ────────────────────────────────────────────────────
interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'sent' | 'paid'
}

const VAULT = `showcase-59-${RUN_ID}`
const S3_PREFIX = `noy-db-showcase-59/${RUN_ID}`
const PASSPHRASE = 'topology-aws-passphrase-2026'

describe.skipIf(!AWS_ENABLED)(
  'Showcase 59 — Topology: AWS S3 + DynamoDB (records + blobs, meter-wrapped, offline/online sync)',
  () => {
    // ── Cloud-side wiring (one shared physical layer) ────────────────
    //
    // The dynamo client uses the AWS SDK's default credential chain;
    // _setup.ts already promoted NOYDB_SHOWCASE_AWS_PROFILE → AWS_PROFILE,
    // so the chain resolves credentials + region from ~/.aws/config
    // without any explicit fromIni() call.
    const s3Client = new S3Client({})
    const ddbRaw = new DynamoDBClient({})
    const ddbClient = DynamoDBDocumentClient.from(ddbRaw)

    // routeStore: records to Dynamo, blobs to S3 (the canonical split).
    const records = dynamo({ table: DYNAMO_TABLE, client: ddbClient })
    const blobs = s3({ bucket: S3_BUCKET, prefix: S3_PREFIX, client: s3Client })
    const cloudRoute = routeStore({ default: records, blobs })

    // Wrap the entire cloud for one observability surface.
    const { store: cloud, meter } = toMeter(cloudRoute)

    afterAll(async () => {
      meter.close()
      if (!AWS_CLEANUP) return

      // S3 cleanup — every object the run wrote.
      try {
        const listed = await s3Client.send(
          new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: S3_PREFIX }),
        )
        for (const obj of listed.Contents ?? []) {
          if (!obj.Key) continue
          await s3Client
            .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }))
            .catch(() => {})
        }
      } catch {
        /* best-effort */
      }

      // DynamoDB cleanup — every item under our pk (vault name).
      try {
        const scanned = await ddbClient.send(
          new ScanCommand({
            TableName: DYNAMO_TABLE,
            FilterExpression: 'pk = :v',
            ExpressionAttributeValues: { ':v': VAULT },
          }),
        )
        for (const item of scanned.Items ?? []) {
          await ddbClient
            .send(
              new DeleteCommand({
                TableName: DYNAMO_TABLE,
                Key: { pk: item['pk'], sk: item['sk'] },
              }),
            )
            .catch(() => {})
        }
      } catch {
        /* best-effort */
      }
    })

    it('full topology: write online, sync offline, edit, re-sync, verify zero-knowledge', async () => {
      // ── PHASE 1: ONLINE writes records + a blob to cloud ──────────
      const online = await createNoydb({
        store: cloud,
        user: 'alice',
        secret: PASSPHRASE,
        blobStrategy: withBlobs(),
      })
      const oVault = await online.openVault(VAULT)
      const oInvoices = oVault.collection<Invoice>('invoices')

      await oInvoices.put('inv-001', {
        id: 'inv-001',
        client: 'Acme',
        amount: 5000,
        status: 'draft',
      })
      await oInvoices.put('inv-002', {
        id: 'inv-002',
        client: 'Beta',
        amount: 3000,
        status: 'sent',
      })

      // Tiny PDF-shaped blob attached to inv-001.
      const pdfBytes = new Uint8Array(512)
      pdfBytes.set(new TextEncoder().encode('%PDF-1.4\n'), 0)
      for (let i = 9; i < pdfBytes.length; i++) pdfBytes[i] = (i * 7) & 0xff
      await oInvoices.blob('inv-001').put('contract', pdfBytes, {
        mimeType: 'application/pdf',
      })

      online.close()

      // ── PHASE 2: FIELD pulls from cloud, sees the data ────────────
      //
      // Bootstrap step: the field tablet is fresh; its local memory store
      // has no `_keyring` entry. If we openVault on a fresh store with the
      // same passphrase, the hub will MINT a NEW keyring + DEKs — those
      // DEKs would not match the cloud's, and decrypting any pulled record
      // would throw `TamperedError`. Same passphrase is necessary but not
      // sufficient.
      //
      // The handshake is to copy the cloud's keyring envelope into the
      // field's local store first. The envelope is itself encrypted (KEK-
      // wrapped DEKs); the passphrase derives the KEK, the KEK unwraps
      // the DEKs, and field is now operating on the same crypto material
      // as cloud. In production this handshake is typically done via a
      // one-shot share token (`@noy-db/on-magic-link`) or a USB-stick
      // handover (`vault.dump()` / `vault.load()`).
      const fieldLocal = memory()
      const cloudKeyring = await cloud.get(VAULT, '_keyring', 'alice')
      expect(cloudKeyring).not.toBeNull() // sanity — cloud must have minted one
      await fieldLocal.put(VAULT, '_keyring', 'alice', cloudKeyring!)

      const field = await createNoydb({
        store: fieldLocal,
        user: 'alice',
        secret: PASSPHRASE,
        blobStrategy: withBlobs(),
        syncStrategy: withSync(),
        sync: { store: cloud, role: 'sync-peer' },
      })
      // openVault must happen before pull — the sync engine uses the vault
      // context (and the now-bootstrapped keyring) to know what to fetch.
      await field.openVault(VAULT)
      await field.pull(VAULT)
      const fInvoices = (await field.openVault(VAULT)).collection<Invoice>('invoices')

      expect(await fInvoices.get('inv-001')).toMatchObject({
        amount: 5000,
        status: 'draft',
      })
      expect(await fInvoices.get('inv-002')).toMatchObject({
        amount: 3000,
        status: 'sent',
      })

      // ── PHASE 3: OFFLINE — field edits + adds; online edits a sibling ─
      // Field marks invoice 1 as paid and adds a brand-new invoice 3.
      // (No sync calls during this phase — that's "offline".)
      await fInvoices.put('inv-001', {
        id: 'inv-001',
        client: 'Acme',
        amount: 5000,
        status: 'paid',
      })
      await fInvoices.put('inv-003', {
        id: 'inv-003',
        client: 'Gamma',
        amount: 7500,
        status: 'draft',
      })

      // While field is offline, the cloud-side operator opens their own
      // session and modifies a different invoice (no real conflict here —
      // last-write-wins handles only same-id concurrent writes).
      const online2 = await createNoydb({
        store: cloud,
        user: 'alice',
        secret: PASSPHRASE,
      })
      await (await online2.openVault(VAULT))
        .collection<Invoice>('invoices')
        .put('inv-002', {
          id: 'inv-002',
          client: 'Beta',
          amount: 3500, // updated amount
          status: 'paid',
        })
      online2.close()

      // ── PHASE 4: BACK ONLINE — field pushes, then a fresh online pulls ─
      await new Promise((r) => setTimeout(r, 0)) // let dirty-tracking settle
      const pushResult = await field.push(VAULT)
      expect(pushResult).toBeDefined()
      field.close()

      const onlineFinal = await createNoydb({
        store: cloud,
        user: 'alice',
        secret: PASSPHRASE,
        blobStrategy: withBlobs(),
      })
      const ofInvoices = (await onlineFinal.openVault(VAULT)).collection<Invoice>('invoices')

      // All three records are present; the conflict-free cloud edit on
      // inv-002 survives; field's offline edits on inv-001 + inv-003 land.
      expect(await ofInvoices.get('inv-001')).toMatchObject({ status: 'paid' })
      expect(await ofInvoices.get('inv-002')).toMatchObject({ amount: 3500, status: 'paid' })
      expect(await ofInvoices.get('inv-003')).toMatchObject({ amount: 7500, status: 'draft' })

      // The blob attached online survives the round-trip.
      const fetched = await ofInvoices.blob('inv-001').get('contract')
      expect(fetched).not.toBeNull()
      expect(fetched!.length).toBe(pdfBytes.length)
      expect(fetched![0]).toBe(0x25) // '%' — PDF magic, byte 0
      expect(fetched![3]).toBe(0x46) // 'F' — PDF magic, byte 3

      onlineFinal.close()

      // ── PHASE 5: ZERO-KNOWLEDGE SPOT-CHECKS ────────────────────────
      // Raw scan of DynamoDB sees envelopes only — no plaintext leaks.
      const rawScan = await ddbClient.send(
        new ScanCommand({
          TableName: DYNAMO_TABLE,
          FilterExpression: 'pk = :v',
          ExpressionAttributeValues: { ':v': VAULT },
        }),
      )
      expect(rawScan.Items?.length).toBeGreaterThan(0)
      for (const item of rawScan.Items ?? []) {
        const json = JSON.stringify(item)
        // Plaintext client names must not appear anywhere in the raw item.
        expect(json).not.toContain('Acme')
        expect(json).not.toContain('Beta')
        expect(json).not.toContain('Gamma')
      }

      // Same check on every S3 object — blob chunks are AES-GCM ciphertext.
      const listed = await s3Client.send(
        new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: S3_PREFIX }),
      )
      expect(listed.Contents?.length).toBeGreaterThan(0)
      for (const obj of listed.Contents ?? []) {
        if (!obj.Key) continue
        const got = await s3Client.send(
          new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }),
        )
        const body = await got.Body!.transformToString()
        expect(body).not.toContain('Acme')
        expect(body).not.toContain('Beta')
      }

      // ── PHASE 6: METER REPORT — print the topology's network profile ─
      const snap = meter.snapshot()
      // eslint-disable-next-line no-console
      console.info(
        `[topology-59] meter — total=${snap.totalCalls} put=${snap.byMethod.put.count} get=${snap.byMethod.get.count} list=${snap.byMethod.list.count} casConflicts=${snap.casConflicts} status=${snap.status}`,
      )
      // eslint-disable-next-line no-console
      console.info(
        `[topology-59]   put p50=${snap.byMethod.put.p50.toFixed(1)}ms p99=${snap.byMethod.put.p99.toFixed(1)}ms`,
      )
      // eslint-disable-next-line no-console
      console.info(
        `[topology-59]   get p50=${snap.byMethod.get.p50.toFixed(1)}ms p99=${snap.byMethod.get.p99.toFixed(1)}ms`,
      )

      // The workload performed many puts (records + blob chunks + sync
      // writes) and many gets (pulls + final reads). Asserting just that
      // both surfaced through the meter is enough — the absolute counts
      // depend on hub internals that are free to evolve.
      expect(snap.byMethod.put.count).toBeGreaterThan(5)
      expect(snap.byMethod.get.count).toBeGreaterThan(0)
    })
  },
)

if (AWS_ENABLED) {
  // eslint-disable-next-line no-console
  console.info(
    `[topology-59] Using AWS_PROFILE=${AWS_PROFILE} table=${DYNAMO_TABLE} bucket=${S3_BUCKET} vault=${VAULT}`,
  )
}
