// @vitest-environment node
//
// happy-dom's fetch enforces same-origin policy and strips privileged
// headers like `Authorization: Bearer <jwt>` on cross-origin POST. The
// supabase-js Storage client builds those headers internally, so the
// upload fails with "headers must have required property 'authorization'".
// AWS-SDK-based showcases (57, 60) bypass happy-dom by using node:https
// directly; supabase-js uses fetch, so we have to opt out of happy-dom
// — same fix as showcases 61, 62, 63.
/**
 * Showcase 65 — Topology: Supabase Postgres + Storage (records + blobs,
 *                          meter-wrapped)
 *
 * What you'll learn
 * ─────────────────
 * The Supabase counterpart to showcase 59 (AWS) and 62 (Cloudflare).
 * `routeStore({ default: <records>, blobs: <blobs> })` wraps:
 *
 *   - **Records** → `@noy-db/to-supabase` (Postgres `jsonb`, casAtomic,
 *     direct connection via `pg` to the project's database URL).
 *   - **Blobs** → an inline `supabaseStorage(...)` wrapper around the
 *     official `@supabase/supabase-js` Storage client. NOT bundled in
 *     the package because the SDK is sizeable; the wrapper lives in
 *     `_supabase-storage-store.ts` for vendor-copy.
 *
 * The whole composite is wrapped in `toMeter()` so the meter
 * snapshot can be compared directly with showcase 59 (AWS) and 62
 * (Cloudflare WAN). Same workload shape, three real backends, one
 * latency-comparison table.
 *
 * Why it matters
 * ──────────────
 * Supabase is the most common single-vendor stack for small
 * regulated teams: Postgres + Storage, one billing line, one auth
 * surface. Adopters considering Supabase want to know: "is this a
 * faster or slower path than DynamoDB+S3?" and "does it preserve
 * zero-knowledge?" Both questions land in the meter snapshot + the
 * direct-SQL spot check.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 64 (records-only Supabase).
 * - Real Supabase project with all THREE env vars set:
 *     - `NOYDB_SHOWCASE_SUPABASE_URL`
 *     - `NOYDB_SHOWCASE_SUPABASE_SECRET_KEY` (the privileged "Secret Key"
 *       from Settings → API; NOT the anon / publishable key)
 *     - `NOYDB_SHOWCASE_SUPABASE_DB_URL`
 * - Bucket `noydb-showcase-blobs` is auto-created on first use; no
 *   manual dashboard setup needed.
 *
 * What to read next
 * ─────────────────
 *   - showcase 59-topology-aws-offline-online (AWS comparison)
 *   - showcase 62-topology-cloudflare-offline-online (Cloudflare WAN)
 *
 * Spec mapping
 * ────────────
 * features.yaml → topologies → supabase-team
 */

import { describe, expect, it } from 'vitest'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import { createNoydb, routeStore } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { supabase } from '@noy-db/to-supabase'
import { toMeter } from '@noy-db/to-meter'
import {
  envGate,
  logSkipHint,
  SUPABASE_GATE_VARS,
  SUPABASE_DEFAULT_BUCKET,
} from './_env.js'
import { supabaseStorage } from './_supabase-storage-store.js'

const gate = envGate({ label: 'topology-supabase', vars: SUPABASE_GATE_VARS })
logSkipHint('topology-supabase (showcase 65)', gate, SUPABASE_GATE_VARS)

interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'sent' | 'paid'
}

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const TABLE = `noydb_showcase_65_${RUN_ID.replace(/-/g, '_')}`
const VAULT = `showcase-65-${RUN_ID}`
const STORAGE_PREFIX = `noy-db-showcase-65/${RUN_ID}`
const PASSPHRASE = 'topology-supabase-passphrase-2026'

describe.skipIf(!gate.enabled)('Showcase 65 — Topology: Supabase Postgres + Storage (records + blobs, meter-wrapped)', () => {
  const url = gate.values['NOYDB_SHOWCASE_SUPABASE_URL']!
  const secretKey = gate.values['NOYDB_SHOWCASE_SUPABASE_SECRET_KEY']!
  const dbUrl = gate.values['NOYDB_SHOWCASE_SUPABASE_DB_URL']!
  const bucketName = process.env['NOYDB_SHOWCASE_SUPABASE_BUCKET'] || SUPABASE_DEFAULT_BUCKET

  // All setup is INSIDE the test body so vitest's retry: 2 (configured
  // for happy-dom WebCrypto flakes) doesn't trip over `pg.Client` being
  // single-use. Each retry gets a fresh client, fresh route, fresh meter.
  // We also disable retries explicitly: Supabase failures are deterministic
  // (auth / RLS errors won't recover by retrying).
  it('records + blobs round-trip via routed Supabase backends, meter sees both legs', { retry: 0 }, async () => {
    const pgClient = new pg.Client({ connectionString: dbUrl })
    const sb = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // autoCreateBucket: false — Supabase's default RLS on storage.buckets
    // can block service-key writes to the buckets table. Create the
    // bucket once via the dashboard (Storage → New bucket → name
    // "noydb-showcase-blobs", private). The wrapper's get/put/list
    // operate on objects within an existing bucket — no buckets-table
    // writes — so RLS-on-buckets stops mattering after this.
    const records = supabase({ client: pgClient, tableName: TABLE })
    const blobs = supabaseStorage({
      client: sb,
      bucket: bucketName,
      prefix: STORAGE_PREFIX,
      autoCreateBucket: false,
    })
    const cloudRoute = routeStore({ default: records, blobs })
    const { store: cloud, meter } = toMeter(cloudRoute)

    await pgClient.connect()

    try {
      const db = await createNoydb({
      store: cloud,
      user: 'alice',
      secret: PASSPHRASE,
      blobStrategy: withBlobs(),
    })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<Invoice>('invoices')

    // Records → Postgres jsonb
    await invoices.put('inv-001', {
      id: 'inv-001',
      client: 'NeedleClient-SUPA-XYZ',
      amount: 5000,
      status: 'draft',
    })
    await invoices.put('inv-002', { id: 'inv-002', client: 'Beta', amount: 3000, status: 'sent' })

    // Blob → Supabase Storage
    const pdfBytes = new Uint8Array(512)
    pdfBytes.set(new TextEncoder().encode('%PDF-1.4\n'), 0)
    for (let i = 9; i < pdfBytes.length; i++) pdfBytes[i] = (i * 7) & 0xff
    await invoices.blob('inv-001').put('contract', pdfBytes, {
      mimeType: 'application/pdf',
    })

    expect(await invoices.get('inv-001')).toMatchObject({ amount: 5000, status: 'draft' })
    expect(await invoices.get('inv-002')).toMatchObject({ amount: 3000, status: 'sent' })

    const fetched = await invoices.blob('inv-001').get('contract')
    expect(fetched).not.toBeNull()
    expect(fetched!.length).toBe(pdfBytes.length)
    expect(fetched![0]).toBe(0x25)
    expect(fetched![3]).toBe(0x46)

    db.close()

    // ── Zero-knowledge spot-checks on both backends ─────────────────
    // Records side: direct SQL. The plaintext sentinel must not appear
    // in the envelope payload column.
    const { rows: pgRows } = await pgClient.query<{ envelope: unknown }>(
      `SELECT envelope FROM ${TABLE} WHERE vault = $1`,
      [VAULT],
    )
    expect(pgRows.length).toBeGreaterThan(0)
    for (const row of pgRows) {
      expect(JSON.stringify(row.envelope)).not.toContain('NeedleClient-SUPA-XYZ')
    }

    // Blob side: pull every Storage object under our prefix and confirm
    // no needle.
    let totalObjects = 0
    const { data: vaults } = await sb.storage
      .from(bucketName)
      .list(STORAGE_PREFIX, { limit: 1000 })
    for (const v of vaults ?? []) {
      if (v.id !== null) continue
      const { data: colls } = await sb.storage
        .from(bucketName)
        .list(`${STORAGE_PREFIX}/${v.name}`, { limit: 1000 })
      for (const c of colls ?? []) {
        if (c.id !== null) continue
        const collPath = `${STORAGE_PREFIX}/${v.name}/${c.name}`
        const { data: items } = await sb.storage.from(bucketName).list(collPath, { limit: 1000 })
        for (const item of items ?? []) {
          totalObjects++
          const { data: blob } = await sb.storage
            .from(bucketName)
            .download(`${collPath}/${item.name}`)
          if (!blob) continue
          const body = await blob.text()
          expect(body).not.toContain('NeedleClient-SUPA-XYZ')
        }
      }
    }
    expect(totalObjects).toBeGreaterThan(0)

    // ── Meter report — for direct A/B with showcases 59 and 62 ──────
    const snap = meter.snapshot()
    // eslint-disable-next-line no-console
    console.info(
      `[topology-65] meter — total=${snap.totalCalls} put=${snap.byMethod.put.count} get=${snap.byMethod.get.count} list=${snap.byMethod.list.count} casConflicts=${snap.casConflicts} status=${snap.status}`,
    )
    // eslint-disable-next-line no-console
    console.info(
      `[topology-65]   put p50=${snap.byMethod.put.p50.toFixed(1)}ms p99=${snap.byMethod.put.p99.toFixed(1)}ms`,
    )
    // eslint-disable-next-line no-console
    console.info(
      `[topology-65]   get p50=${snap.byMethod.get.p50.toFixed(1)}ms p99=${snap.byMethod.get.p99.toFixed(1)}ms`,
    )

    expect(snap.byMethod.put.count).toBeGreaterThan(0)
    expect(snap.byMethod.get.count).toBeGreaterThan(0)
    } finally {
      // ── Cleanup — DROP table + remove Storage objects under prefix ──
      try {
        await pgClient.query(`DROP TABLE IF EXISTS ${TABLE}`)
      } catch {
        /* best-effort */
      }
      await pgClient.end().catch(() => {})

      try {
        const { data: vaults } = await sb.storage
          .from(bucketName)
          .list(STORAGE_PREFIX, { limit: 1000 })
        for (const v of vaults ?? []) {
          if (v.id !== null) continue
          const { data: colls } = await sb.storage
            .from(bucketName)
            .list(`${STORAGE_PREFIX}/${v.name}`, { limit: 1000 })
          for (const c of colls ?? []) {
            if (c.id !== null) continue
            const collPath = `${STORAGE_PREFIX}/${v.name}/${c.name}`
            const { data: items } = await sb.storage.from(bucketName).list(collPath, { limit: 1000 })
            if (items && items.length > 0) {
              await sb.storage
                .from(bucketName)
                .remove(items.map((i) => `${collPath}/${i.name}`))
                .catch(() => {})
            }
          }
        }
      } catch {
        /* best-effort */
      }
      meter.close()
    }
  })
})

if (gate.enabled) {
  // eslint-disable-next-line no-console
  console.info(
    `[topology-65] Using table=${TABLE} bucket=${process.env['NOYDB_SHOWCASE_SUPABASE_BUCKET'] || SUPABASE_DEFAULT_BUCKET} prefix=${STORAGE_PREFIX}`,
  )
}
