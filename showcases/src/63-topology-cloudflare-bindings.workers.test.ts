/// <reference types="@cloudflare/workers-types" />
/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Showcase 63 — Topology: Cloudflare Worker bindings (env.DB + env.BUCKET)
 *
 * What you'll learn
 * ─────────────────
 * The same NOYDB topology that showcase 62 runs *over the WAN* —
 * routeStore({ default: <records>, blobs: <blobs> }) wrapped in
 * toMeter() — but here records hit `env.DB` (the D1 binding, an
 * in-process call) and blobs hit `env.BUCKET` (the R2 binding, also
 * in-process). No fetch. No HTTPS. No api.cloudflare.com round-trip.
 * The application code is byte-for-byte the same; only the cloud-
 * side wiring inside the routeStore changes.
 *
 * IMPORTANT — local emulation, not real Cloudflare
 * ──────────────────────────────────────────────────
 * This file runs under `@cloudflare/vitest-pool-workers` 0.6.x, the
 * latest line that's compatible with vitest 2.1.x (the version the
 * rest of the showcase suite uses). 0.6.x predates the
 * `experimental_remote: true` flag (introduced in 0.9.x + vitest 4.x),
 * so the bindings are **miniflare local emulators**:
 *
 *   - `env.DB` → local SQLite via miniflare's D1 simulator
 *   - `env.BUCKET` → local filesystem via miniflare's R2 simulator
 *
 * The latency numbers in the meter snapshot are local-emulator
 * artifacts (sub-millisecond). They are NOT real Cloudflare numbers.
 * What this showcase does prove:
 *
 *   1. The binding code path compiles and runs end-to-end.
 *   2. The same NOYDB workflow (routeStore + meter + zero-knowledge)
 *      that works against AWS SDKs and Cloudflare REST also works
 *      against the binding API surface.
 *   3. Adopters running on Cloudflare can swap their `to-cloudflare-d1`
 *      / `to-cloudflare-r2` REST instantiations for binding-backed
 *      ones in one line — no application changes.
 *
 * For real-Cloudflare binding latency, the path is:
 *   - Upgrade the showcases package to vitest 4.x and pool-workers
 *     0.9.x, then add `experimental_remote: true` to wrangler.jsonc;
 *     OR
 *   - Deploy a real Worker with this same code, expose a /run
 *     endpoint, and call it from outside (separate "63b" showcase).
 *
 * Prerequisites
 * ─────────────
 * - Showcase 62 (the WAN version of this same topology — the
 *   side-by-side comparison is the whole point).
 * - `pnpm install` has the dev-deps installed (workerd, miniflare, etc.)
 *
 * Run with: `pnpm test:workers`
 *
 * What to read next
 * ─────────────────
 *   - showcase 62 (WAN-from-Node, real Cloudflare)
 *   - https://developers.cloudflare.com/workers/testing/vitest-integration/
 *
 * Spec mapping
 * ────────────
 * features.yaml → topologies → cloudflare-worker-bindings
 */

import { env } from 'cloudflare:test'
import { afterAll, describe, expect, it } from 'vitest'
import { createNoydb, routeStore } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { d1 } from '@noy-db/to-cloudflare-d1'
import { toMeter } from '@noy-db/to-meter'
import { r2Binding } from './_r2-binding-store.js'

interface WorkerEnv {
  readonly DB: D1Database
  readonly BUCKET: R2Bucket
}

const e = env as WorkerEnv

interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'sent' | 'paid'
}

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const VAULT = `showcase-63-${RUN_ID}`
const D1_TABLE = `noydb_showcase_63_${RUN_ID.replace(/-/g, '_')}`
const R2_PREFIX = `noy-db-showcase-63/${RUN_ID}`
const PASSPHRASE = 'topology-cloudflare-bindings-2026'

describe('Showcase 63 — Topology: Cloudflare Worker bindings (env.DB + env.BUCKET, local emulation)', () => {
  // ── Cloud-side wiring — bindings, NOT REST ──────────────────────────
  const records = d1({ db: e.DB, tableName: D1_TABLE })
  const blobs = r2Binding({ bucket: e.BUCKET, prefix: R2_PREFIX })
  const route = routeStore({ default: records, blobs })
  const { store, meter } = toMeter(route)

  afterAll(async () => {
    meter.close()
    // Drop the per-run D1 table.
    try {
      await e.DB.prepare(`DROP TABLE IF EXISTS ${D1_TABLE}`).run()
    } catch {
      /* best-effort */
    }
    // Delete every R2 object under the run prefix.
    try {
      let cursor: string | undefined
      const toDelete: string[] = []
      do {
        const opts: R2ListOptions = { prefix: R2_PREFIX }
        if (cursor !== undefined) opts.cursor = cursor
        const page = await e.BUCKET.list(opts)
        for (const obj of page.objects) toDelete.push(obj.key)
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      if (toDelete.length > 0) await e.BUCKET.delete(toDelete)
    } catch {
      /* best-effort */
    }
  })

  it('round-trips records + blob through bindings, ciphertext-only at the storage layer, meter sees in-process latency', async () => {
    // ── PHASE 1: records + blob round-trip via bindings ──────────────
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: PASSPHRASE,
      blobStrategy: withBlobs(),
    })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<Invoice>('invoices')

    // Records → D1 binding (in-process, no fetch)
    await invoices.put('inv-001', {
      id: 'inv-001',
      client: 'NeedleClient-XYZ',
      amount: 5000,
      status: 'draft',
    })
    await invoices.put('inv-002', { id: 'inv-002', client: 'Beta', amount: 3000, status: 'sent' })

    // Blob → R2 binding (in-process, no fetch)
    const pdfBytes = new Uint8Array(512)
    pdfBytes.set(new TextEncoder().encode('%PDF-1.4\n'), 0)
    for (let i = 9; i < pdfBytes.length; i++) pdfBytes[i] = (i * 7) & 0xff
    await invoices.blob('inv-001').put('contract', pdfBytes, { mimeType: 'application/pdf' })

    expect(await invoices.get('inv-001')).toMatchObject({ amount: 5000, status: 'draft' })
    expect(await invoices.get('inv-002')).toMatchObject({ amount: 3000, status: 'sent' })

    const fetched = await invoices.blob('inv-001').get('contract')
    expect(fetched).not.toBeNull()
    expect(fetched!.length).toBe(pdfBytes.length)
    expect(fetched![0]).toBe(0x25) // %
    expect(fetched![3]).toBe(0x46) // F

    db.close()

    // ── PHASE 2: ZERO-KNOWLEDGE — direct binding queries, raw bytes
    // Skip NOYDB on this side; just hit the bindings as Cloudflare staff
    // would. The plaintext sentinel must not appear in any storage byte.
    const dRows = await e.DB
      .prepare(`SELECT * FROM ${D1_TABLE} WHERE vault = ?`)
      .bind(VAULT)
      .all<Record<string, unknown>>()
    expect((dRows.results ?? []).length).toBeGreaterThan(0)
    for (const row of dRows.results ?? []) {
      expect(JSON.stringify(row)).not.toContain('NeedleClient-XYZ')
    }

    // Same check on every R2 object under our prefix.
    let cursor: string | undefined
    let r2Total = 0
    do {
      const opts: R2ListOptions = { prefix: R2_PREFIX }
      if (cursor !== undefined) opts.cursor = cursor
      const page = await e.BUCKET.list(opts)
      for (const obj of page.objects) {
        r2Total++
        const got = await e.BUCKET.get(obj.key)
        if (!got) continue
        const body = await got.text()
        expect(body).not.toContain('NeedleClient-XYZ')
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    expect(r2Total).toBeGreaterThan(0)

    // ── PHASE 3: METER REPORT — note: local emulator, not real CF
    const snap = meter.snapshot()
    // eslint-disable-next-line no-console
    console.info(
      `[topology-63] meter — total=${snap.totalCalls} put=${snap.byMethod.put.count} get=${snap.byMethod.get.count} list=${snap.byMethod.list.count} casConflicts=${snap.casConflicts} status=${snap.status}`,
    )
    // eslint-disable-next-line no-console
    console.info(
      `[topology-63]   put p50=${snap.byMethod.put.p50.toFixed(2)}ms p99=${snap.byMethod.put.p99.toFixed(2)}ms`,
    )
    // eslint-disable-next-line no-console
    console.info(
      `[topology-63]   get p50=${snap.byMethod.get.p50.toFixed(2)}ms p99=${snap.byMethod.get.p99.toFixed(2)}ms`,
    )
    // eslint-disable-next-line no-console
    console.info(
      `[topology-63]   ⚠ local miniflare emulation — NOT real Cloudflare latency. See showcase 62 for the WAN-real numbers.`,
    )

    expect(snap.totalCalls).toBeGreaterThan(0)
    expect(snap.byMethod.put.count).toBeGreaterThan(0)
  })
})
