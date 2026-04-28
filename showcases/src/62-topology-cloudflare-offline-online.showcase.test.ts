// @vitest-environment node
//
// happy-dom blocks the cross-origin POST our D1 REST shim makes — same
// reason as showcase 61. AWS-SDK paths (used by R2 here, since
// to-cloudflare-r2 delegates to to-aws-s3) bypass happy-dom by going
// through node:https directly, so the R2 calls would work either way;
// the directive is needed because of the D1 side.
/**
 * Showcase 62 — Topology: Cloudflare D1 + R2 end-to-end (records + blobs,
 *                          meter-wrapped, offline/online sync)
 *
 * What you'll learn
 * ─────────────────
 * The Cloudflare-edge counterpart to showcase 59. Same routed cloud,
 * same offline-tablet workflow, same zero-knowledge invariant — but
 * with `to-cloudflare-d1` carrying records (via the REST shim) and
 * `to-cloudflare-r2` carrying blob chunks. Reading 59 and 62 side by
 * side gives you a direct A/B comparison of the two clouds:
 * authentication path, latency profile, conflict-resolution surface,
 * cleanup ergonomics, billable-call profile.
 *
 * Why it matters
 * ──────────────
 * Choosing a cloud is rarely a single-vendor decision — adopters often
 * run primary on AWS and DR on Cloudflare (or vice versa) because the
 * egress economics of R2 are favourable for read-heavy blobs while
 * Dynamo's strongly-consistent CAS is favourable for hot records.
 * NOYDB's `routeStore` makes both topologies a one-line wiring change
 * away from each other; this showcase exercises the Cloudflare half so
 * the choice is data-driven rather than vibes-driven. The meter
 * snapshot lets you compare put/get p99 across runs.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 59 (the AWS sibling — same workflow shape).
 * - Showcase 60 + 61 (the individual backends, mocked + real).
 * - Showcase 08 (withBlobs) and 15 (withSync) for the primitives.
 * - Real Cloudflare:
 *     - all four `NOYDB_SHOWCASE_R2_*` vars
 *     - all three `NOYDB_SHOWCASE_D1_*` vars
 *
 * Skipped cleanly when either gate is closed.
 *
 * What to read next
 * ─────────────────
 *   - showcase 59-topology-aws-offline-online (the AWS sibling)
 *   - docs/subsystems/sync.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → topologies → cloudflare-edge-team
 */

import { afterAll, describe, expect, it } from 'vitest'
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { createNoydb, routeStore } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { withSync } from '@noy-db/hub/sync'
import { d1 } from '@noy-db/to-cloudflare-d1'
import { r2, r2EndpointFor } from '@noy-db/to-cloudflare-r2'
import { memory } from '@noy-db/to-memory'
import { toMeter } from '@noy-db/to-meter'

import {
  envGate,
  logSkipHint,
  R2_GATE_VARS,
  R2_DEFAULT_BUCKET,
  D1_GATE_VARS,
} from './_env.js'
import { sdkD1 } from './_d1-sdk.js'

const r2Gate = envGate({ label: 'topology-cloudflare (R2)', vars: R2_GATE_VARS })
const d1Gate = envGate({ label: 'topology-cloudflare (D1)', vars: D1_GATE_VARS })
logSkipHint('topology-cloudflare R2 (showcase 62)', r2Gate, R2_GATE_VARS)
logSkipHint('topology-cloudflare D1 (showcase 62)', d1Gate, D1_GATE_VARS)

const ENABLED = r2Gate.enabled && d1Gate.enabled

interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'sent' | 'paid'
}

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const VAULT = `showcase-62-${RUN_ID}`
const R2_PREFIX = `noy-db-showcase-62/${RUN_ID}`
const D1_TABLE = `noydb_showcase_62_${RUN_ID.replace(/-/g, '_')}`
const PASSPHRASE = 'topology-cloudflare-passphrase-2026'

describe.skipIf(!ENABLED)(
  'Showcase 62 — Topology: Cloudflare D1 + R2 (records + blobs, meter-wrapped, offline/online sync)',
  () => {
    const r2AccountId = r2Gate.values['NOYDB_SHOWCASE_R2_ACCOUNT_ID']!
    const r2AccessKeyId = r2Gate.values['NOYDB_SHOWCASE_R2_ACCESS_KEY_ID']!
    const r2SecretAccessKey = r2Gate.values['NOYDB_SHOWCASE_R2_SECRET_ACCESS_KEY']!
    const r2Bucket = process.env['NOYDB_SHOWCASE_R2_BUCKET'] || R2_DEFAULT_BUCKET

    const d1AccountId = d1Gate.values['NOYDB_SHOWCASE_D1_ACCOUNT_ID']!
    const d1DatabaseId = d1Gate.values['NOYDB_SHOWCASE_D1_DATABASE_ID']!
    const d1ApiToken = d1Gate.values['NOYDB_SHOWCASE_D1_API_TOKEN']!

    // ── Cloud-side wiring ────────────────────────────────────────────
    //
    // D1: REST-shim handles HTTP + auth; the store sees a binding-shaped
    // object. R2: S3-compat client points at <accountId>.r2.cloudflarestorage.com
    // with region "auto" + path-style addressing. Same routeStore split as
    // showcase 59 — records to default (D1), blobs to R2.
    const records = d1({
      db: sdkD1({ accountId: d1AccountId, databaseId: d1DatabaseId, apiToken: d1ApiToken }),
      tableName: D1_TABLE,
    })
    const blobs = r2({
      accountId: r2AccountId,
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
      bucket: r2Bucket,
      prefix: R2_PREFIX,
    })
    const cloudRoute = routeStore({ default: records, blobs })
    const { store: cloud, meter } = toMeter(cloudRoute)

    // Raw clients used only for cleanup + zero-knowledge spot-checks.
    const rawR2 = new S3Client({
      region: 'auto',
      endpoint: r2EndpointFor(r2AccountId),
      credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey },
      forcePathStyle: true,
    })
    const rawD1 = sdkD1({ accountId: d1AccountId, databaseId: d1DatabaseId, apiToken: d1ApiToken })

    afterAll(async () => {
      meter.close()

      // R2 cleanup — every object under the run prefix.
      try {
        const listed = await rawR2.send(
          new ListObjectsV2Command({ Bucket: r2Bucket, Prefix: R2_PREFIX }),
        )
        for (const obj of listed.Contents ?? []) {
          if (!obj.Key) continue
          await rawR2
            .send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: obj.Key }))
            .catch(() => {})
        }
      } catch {
        /* best-effort */
      }

      // D1 cleanup — drop the per-run table.
      try {
        await rawD1.prepare(`DROP TABLE IF EXISTS ${D1_TABLE}`).run()
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

      const pdfBytes = new Uint8Array(512)
      pdfBytes.set(new TextEncoder().encode('%PDF-1.4\n'), 0)
      for (let i = 9; i < pdfBytes.length; i++) pdfBytes[i] = (i * 7) & 0xff
      await oInvoices.blob('inv-001').put('contract', pdfBytes, {
        mimeType: 'application/pdf',
      })

      online.close()

      // ── PHASE 2: FIELD bootstraps keyring, then pulls ─────────────
      const fieldLocal = memory()
      const cloudKeyring = await cloud.get(VAULT, '_keyring', 'alice')
      expect(cloudKeyring).not.toBeNull()
      await fieldLocal.put(VAULT, '_keyring', 'alice', cloudKeyring!)

      const field = await createNoydb({
        store: fieldLocal,
        user: 'alice',
        secret: PASSPHRASE,
        blobStrategy: withBlobs(),
        syncStrategy: withSync(),
        sync: { store: cloud, role: 'sync-peer' },
      })
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

      // ── PHASE 3: OFFLINE — field edits + adds; online edits a sibling
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
          amount: 3500,
          status: 'paid',
        })
      online2.close()

      // ── PHASE 4: BACK ONLINE — field pushes, then a fresh online pulls
      await new Promise((r) => setTimeout(r, 0))
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

      expect(await ofInvoices.get('inv-001')).toMatchObject({ status: 'paid' })
      expect(await ofInvoices.get('inv-002')).toMatchObject({ amount: 3500, status: 'paid' })
      expect(await ofInvoices.get('inv-003')).toMatchObject({ amount: 7500, status: 'draft' })

      const fetched = await ofInvoices.blob('inv-001').get('contract')
      expect(fetched).not.toBeNull()
      expect(fetched!.length).toBe(pdfBytes.length)
      expect(fetched![0]).toBe(0x25)
      expect(fetched![3]).toBe(0x46)

      onlineFinal.close()

      // ── PHASE 5: ZERO-KNOWLEDGE SPOT-CHECKS ────────────────────────
      // D1: raw SQL — all rows for our vault must be ciphertext only.
      const dRows = await rawD1
        .prepare(`SELECT * FROM ${D1_TABLE} WHERE vault = ?`)
        .bind(VAULT)
        .all<Record<string, unknown>>()
      expect(dRows.results?.length ?? 0).toBeGreaterThan(0)
      for (const row of dRows.results ?? []) {
        const json = JSON.stringify(row)
        expect(json).not.toContain('Acme')
        expect(json).not.toContain('Beta')
        expect(json).not.toContain('Gamma')
      }

      // R2: every blob chunk fetched raw must be ciphertext only.
      const rListed = await rawR2.send(
        new ListObjectsV2Command({ Bucket: r2Bucket, Prefix: R2_PREFIX }),
      )
      expect(rListed.Contents?.length).toBeGreaterThan(0)
      for (const obj of rListed.Contents ?? []) {
        if (!obj.Key) continue
        const got = await rawR2.send(
          new GetObjectCommand({ Bucket: r2Bucket, Key: obj.Key }),
        )
        const body = await got.Body!.transformToString()
        expect(body).not.toContain('Acme')
        expect(body).not.toContain('Beta')
      }

      // ── PHASE 6: METER REPORT — for direct A/B with showcase 59 ────
      const snap = meter.snapshot()
      // eslint-disable-next-line no-console
      console.info(
        `[topology-62] meter — total=${snap.totalCalls} put=${snap.byMethod.put.count} get=${snap.byMethod.get.count} list=${snap.byMethod.list.count} casConflicts=${snap.casConflicts} status=${snap.status}`,
      )
      // eslint-disable-next-line no-console
      console.info(
        `[topology-62]   put p50=${snap.byMethod.put.p50.toFixed(1)}ms p99=${snap.byMethod.put.p99.toFixed(1)}ms`,
      )
      // eslint-disable-next-line no-console
      console.info(
        `[topology-62]   get p50=${snap.byMethod.get.p50.toFixed(1)}ms p99=${snap.byMethod.get.p99.toFixed(1)}ms`,
      )

      expect(snap.byMethod.put.count).toBeGreaterThan(5)
      expect(snap.byMethod.get.count).toBeGreaterThan(0)
    })
  },
)

if (ENABLED) {
  // eslint-disable-next-line no-console
  console.info(
    `[topology-62] Using account=${r2AccountIdShort()} table=${D1_TABLE} bucket=${process.env['NOYDB_SHOWCASE_R2_BUCKET'] || R2_DEFAULT_BUCKET} vault=${VAULT}`,
  )
}

function r2AccountIdShort(): string {
  return (process.env['NOYDB_SHOWCASE_R2_ACCOUNT_ID'] ?? '').slice(0, 8) + '…'
}
