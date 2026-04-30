// @vitest-environment node
//
// Same reason as showcases 61, 62, 65 — the supabase-js Storage client
// uses fetch, and happy-dom strips the Authorization header on cross-
// origin POSTs. The pg connection itself works in either env, but the
// Storage half forces node here.
/**
 * Showcase 66 — Topology: Supabase Postgres + Storage (records + blobs,
 *                          meter-wrapped, offline/online sync)
 *
 * What you'll learn
 * ─────────────────
 * The Supabase counterpart to showcase 59 (AWS) and 62 (Cloudflare WAN).
 * Same workflow shape, same 32-call profile, same meter wrap — different
 * cloud-side wiring. Pair this file's output with 59 and 62 to see the
 * full three-way "where does the offline-tablet workflow run faster"
 * comparison.
 *
 * Why it matters
 * ──────────────
 * The first-consumer profile (regulated accounting firm with field
 * tablets) will pick a cloud based on three factors: latency from the
 * tablet's network, write economics, and jurisdiction-of-data. AWS,
 * Cloudflare, and Supabase each solve those differently. Showcases 59
 * + 62 + 66 give them the same workflow on all three so the choice is
 * data-driven.
 *
 * Showcase 65 covers the simpler "round-trip + ZK" case (17 calls).
 * This file extends it to the full offline/online sync workflow (32
 * calls) — the meter snapshots are now directly comparable across the
 * AWS / Cloudflare / Supabase trio.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 59 and 62 (the comparable runs).
 * - Showcase 65 (the simpler Supabase variant).
 * - Real Supabase project with all THREE env vars set:
 *     - `NOYDB_SHOWCASE_SUPABASE_URL`
 *     - `NOYDB_SHOWCASE_SUPABASE_SECRET_KEY` (service_role JWT)
 *     - `NOYDB_SHOWCASE_SUPABASE_DB_URL` (Session pooler URL)
 * - Bucket `noydb-showcase-blobs` must exist (Storage → New bucket
 *   → private). Same one showcase 65 uses.
 *
 * What to read next
 * ─────────────────
 *   - showcase 59-topology-aws-offline-online (AWS comparison)
 *   - showcase 62-topology-cloudflare-offline-online (Cloudflare WAN)
 *   - showcase 65-topology-supabase-records-blobs (the simpler variant)
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
import { withSync } from '@noy-db/hub/sync'
import { supabase } from '@noy-db/to-supabase'
import { memory } from '@noy-db/to-memory'
import { toMeter } from '@noy-db/to-meter'
import {
  envGate,
  logSkipHint,
  SUPABASE_GATE_VARS,
  SUPABASE_DEFAULT_BUCKET,
} from './_env.js'
import { supabaseStorage } from './_supabase-storage-store.js'

const gate = envGate({ label: 'topology-supabase-sync', vars: SUPABASE_GATE_VARS })
logSkipHint('topology-supabase-sync (showcase 66)', gate, SUPABASE_GATE_VARS)

interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'sent' | 'paid'
}

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const TABLE = `noydb_showcase_66_${RUN_ID.replace(/-/g, '_')}`
const VAULT = `showcase-66-${RUN_ID}`
const STORAGE_PREFIX = `noy-db-showcase-66/${RUN_ID}`
const PASSPHRASE = 'topology-supabase-sync-passphrase-2026'

describe.skipIf(!gate.enabled)(
  'Showcase 66 — Topology: Supabase Postgres + Storage (records + blobs, meter-wrapped, offline/online sync)',
  () => {
    const url = gate.values['NOYDB_SHOWCASE_SUPABASE_URL']!
    const secretKey = gate.values['NOYDB_SHOWCASE_SUPABASE_SECRET_KEY']!
    const dbUrl = gate.values['NOYDB_SHOWCASE_SUPABASE_DB_URL']!
    const bucketName = process.env['NOYDB_SHOWCASE_SUPABASE_BUCKET'] || SUPABASE_DEFAULT_BUCKET

    it(
      'full topology: write online, sync offline, edit, re-sync, verify zero-knowledge',
      { retry: 0 },
      async () => {
        // All setup is INSIDE the test body — same retry-safe pattern as 65.
        const pgClient = new pg.Client({ connectionString: dbUrl })
        const sb = createClient(url, secretKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })

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
          // ── PHASE 1: ONLINE writes records + a blob to cloud ──────
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
            client: 'NeedleClient-SUPA-SYNC',
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

          // ── PHASE 2: FIELD bootstraps keyring + pulls ─────────────
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

          // ── PHASE 3: OFFLINE — field edits + adds; online edits sibling
          await fInvoices.put('inv-001', {
            id: 'inv-001',
            client: 'NeedleClient-SUPA-SYNC',
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

          // ── PHASE 4: BACK ONLINE — field pushes, fresh online pulls
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

          // ── PHASE 5: ZERO-KNOWLEDGE SPOT-CHECKS ────────────────────
          const { rows: pgRows } = await pgClient.query<{ envelope: unknown }>(
            `SELECT envelope FROM ${TABLE} WHERE vault = $1`,
            [VAULT],
          )
          expect(pgRows.length).toBeGreaterThan(0)
          for (const row of pgRows) {
            expect(JSON.stringify(row.envelope)).not.toContain('NeedleClient-SUPA-SYNC')
          }

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
              const { data: items } = await sb.storage
                .from(bucketName)
                .list(collPath, { limit: 1000 })
              for (const item of items ?? []) {
                totalObjects++
                const { data: blob } = await sb.storage
                  .from(bucketName)
                  .download(`${collPath}/${item.name}`)
                if (!blob) continue
                const body = await blob.text()
                expect(body).not.toContain('NeedleClient-SUPA-SYNC')
              }
            }
          }
          expect(totalObjects).toBeGreaterThan(0)

          // ── PHASE 6: METER REPORT — direct A/B with 59 + 62 ────────
          const snap = meter.snapshot()
          // eslint-disable-next-line no-console
          console.info(
            `[topology-66] meter — total=${snap.totalCalls} put=${snap.byMethod.put.count} get=${snap.byMethod.get.count} list=${snap.byMethod.list.count} casConflicts=${snap.casConflicts} status=${snap.status}`,
          )
          // eslint-disable-next-line no-console
          console.info(
            `[topology-66]   put p50=${snap.byMethod.put.p50.toFixed(1)}ms p99=${snap.byMethod.put.p99.toFixed(1)}ms`,
          )
          // eslint-disable-next-line no-console
          console.info(
            `[topology-66]   get p50=${snap.byMethod.get.p50.toFixed(1)}ms p99=${snap.byMethod.get.p99.toFixed(1)}ms`,
          )

          expect(snap.byMethod.put.count).toBeGreaterThan(5)
          expect(snap.byMethod.get.count).toBeGreaterThan(0)
        } finally {
          // ── Cleanup ───────────────────────────────────────────────
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
                const { data: items } = await sb.storage
                  .from(bucketName)
                  .list(collPath, { limit: 1000 })
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
      },
    )
  },
)

if (gate.enabled) {
  // eslint-disable-next-line no-console
  console.info(
    `[topology-66] Using table=${TABLE} bucket=${process.env['NOYDB_SHOWCASE_SUPABASE_BUCKET'] || SUPABASE_DEFAULT_BUCKET} prefix=${STORAGE_PREFIX}`,
  )
}
