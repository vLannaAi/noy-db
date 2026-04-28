// @vitest-environment node
//
// to-webdav uses globalThis.fetch internally; happy-dom strips
// Authorization headers on cross-origin POSTs — same hazard as
// every other showcase that talks to a remote HTTPS API. node env
// fixes it.
/**
 * Showcase 69 — Topology: hot records + WebDAV blobs (BYO-cloud /
 *                          NAS / managed-storage subscription, meter-wrapped)
 *
 * What you'll learn
 * ─────────────────
 * `routeStore({ default: <fast>, blobs: <webdav> })` is the canonical
 * pattern for adopters who already have a NAS, a Nextcloud, or a
 * paid file-storage subscription (DriveHQ, Box, ownCloud, Synology,
 * QNAP, …) and want to route blob chunks there without paying for
 * cloud blob storage. Records stay in a hot, casAtomic-capable
 * backend — `to-memory` here for the showcase, `to-postgres` /
 * `to-aws-dynamo` / `to-cloudflare-d1` in production. Blob chunks
 * land on WebDAV where HTTP-per-op latency doesn't matter (chunks
 * are write-once, infrequently-read).
 *
 * The whole composite is wrapped in `toMeter()` so the per-method
 * snapshot lets you see exactly where time is spent — most calls
 * hit the fast records side; a smaller fraction hits the slower
 * WebDAV blob side. That ratio is the key data point when deciding
 * whether to keep blobs on WebDAV or upgrade to S3-compat.
 *
 * Why it matters
 * ──────────────
 * The single most-asked-for production topology by adopters who run
 * a Nextcloud or NAS already. NOYDB encrypts before any byte hits
 * WebDAV, so the existing on-prem storage gets repurposed as an
 * end-to-end-encrypted blob bucket without changing its access
 * controls or trust model.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 68 (the records-only WebDAV check — confirms your
 *   creds work).
 * - Same WebDAV env vars: `NOYDB_SHOWCASE_WEBDAV_URL`, `_USERNAME`,
 *   `_PASSWORD`.
 *
 * Skipped cleanly when those aren't present.
 *
 * What to read next
 * ─────────────────
 *   - showcase 68-storage-webdav (records-only sibling)
 *   - showcase 59 / 62 / 66 (cloud-only topology comparisons)
 *
 * Spec mapping
 * ────────────
 * features.yaml → topologies → byo-blob-webdav
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createNoydb, routeStore } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { memory } from '@noy-db/to-memory'
import { webdav } from '@noy-db/to-webdav'
import { toMeter } from '@noy-db/to-meter'
import { envGate, logSkipHint, WEBDAV_GATE_VARS } from './_env.js'

const gate = envGate({ label: 'topology-webdav-blobs', vars: WEBDAV_GATE_VARS })
logSkipHint('topology-webdav-blobs (showcase 69)', gate, WEBDAV_GATE_VARS)

interface Invoice {
  id: string
  client: string
  amount: number
  status: 'draft' | 'sent' | 'paid'
}

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const PREFIX = `noy-db-showcase-69_${RUN_ID}`
const VAULT = `showcase-69-${RUN_ID}`
const PASSPHRASE = 'topology-webdav-blobs-passphrase-2026'

describe.skipIf(!gate.enabled)('Showcase 69 — Topology: memory records + WebDAV blobs (meter-wrapped)', () => {
  const baseUrl = gate.values['NOYDB_SHOWCASE_WEBDAV_URL']!
  const username = gate.values['NOYDB_SHOWCASE_WEBDAV_USERNAME']!
  const password = gate.values['NOYDB_SHOWCASE_WEBDAV_PASSWORD']!
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const baseHeaders = { Authorization: authHeader }

  // routeStore: records stay in memory (fast, casAtomic), blobs go to
  // WebDAV. Wrap the whole thing in the meter so the snapshot can
  // distinguish "where is the time going?".
  const records = memory()
  // eagerMkcol: true — workaround for DriveHQ's non-RFC PUT-to-nonexistent
  // behavior (returns 204 and silently flattens to root). See package
  // docstring or showcase 68 comment for the full diagnosis.
  const blobs = webdav({ baseUrl, prefix: PREFIX, headers: baseHeaders, eagerMkcol: true })
  const route = routeStore({ default: records, blobs })
  const { store, meter } = toMeter(route)

  afterAll(async () => {
    meter.close()
    // WebDAV cleanup — best-effort DELETE on the run prefix.
    try {
      await fetch(`${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(PREFIX)}`, {
        method: 'DELETE',
        headers: baseHeaders,
      })
    } catch {
      /* best-effort */
    }
  })

  it('records stay hot in memory, blob chunks ride WebDAV, meter sees both legs', async () => {
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: PASSPHRASE,
      blobStrategy: withBlobs(),
    })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<Invoice>('invoices')

    // Records → in-memory primary
    await invoices.put('inv-001', {
      id: 'inv-001',
      client: 'NeedleClient-WEBDAV-UVW',
      amount: 5000,
      status: 'draft',
    })
    await invoices.put('inv-002', { id: 'inv-002', client: 'Beta', amount: 3000, status: 'sent' })

    // Blob → WebDAV. The PDF round-trip exercises the slower leg of
    // the route — meter will show distinctly higher put p99 than the
    // record-side leg.
    const pdfBytes = new Uint8Array(512)
    pdfBytes.set(new TextEncoder().encode('%PDF-1.4\n'), 0)
    for (let i = 9; i < pdfBytes.length; i++) pdfBytes[i] = (i * 7) & 0xff
    await invoices.blob('inv-001').put('contract', pdfBytes, {
      mimeType: 'application/pdf',
    })

    // Round-trip checks — both sides
    expect(await invoices.get('inv-001')).toMatchObject({ amount: 5000, status: 'draft' })
    expect(await invoices.get('inv-002')).toMatchObject({ amount: 3000, status: 'sent' })

    const fetched = await invoices.blob('inv-001').get('contract')
    expect(fetched).not.toBeNull()
    expect(fetched!.length).toBe(pdfBytes.length)
    expect(fetched![0]).toBe(0x25) // %
    expect(fetched![3]).toBe(0x46) // F

    db.close()

    // ── Zero-knowledge — both legs ────────────────────────────────
    // Records side: memory is the primary, but the routed store goes
    // through encryption first. Inspect the route's records leg directly
    // via its store interface — the envelope payload should be ciphertext.
    const recordEnvelope = await records.get(VAULT, 'invoices', 'inv-001')
    expect(recordEnvelope).not.toBeNull()
    const recordWire = JSON.stringify(recordEnvelope)
    expect(recordWire).not.toContain('NeedleClient-WEBDAV-UVW')
    expect(recordWire).toContain('"_data"') // base64 ciphertext field

    // Blob side: similar — route through the underlying webdav store.
    // We need to find a chunk to inspect. The blob-set machinery names
    // chunks like `_blob_chunks/<sha>_0`. Listing the collection lets
    // us pick one without hard-coding the hash.
    const chunkIds = await blobs.list(VAULT, '_blob_chunks')
    expect(chunkIds.length).toBeGreaterThan(0)
    const chunkEnvelope = await blobs.get(VAULT, '_blob_chunks', chunkIds[0]!)
    expect(chunkEnvelope).not.toBeNull()
    const chunkWire = JSON.stringify(chunkEnvelope)
    expect(chunkWire).not.toContain('NeedleClient-WEBDAV-UVW')
    expect(chunkWire).toContain('"_data"')

    // ── Meter report — for direct A/B with 59 / 62 / 66 ────────────
    const snap = meter.snapshot()
    // eslint-disable-next-line no-console
    console.info(
      `[topology-69] meter — total=${snap.totalCalls} put=${snap.byMethod.put.count} get=${snap.byMethod.get.count} list=${snap.byMethod.list.count} casConflicts=${snap.casConflicts} status=${snap.status}`,
    )
    // eslint-disable-next-line no-console
    console.info(
      `[topology-69]   put p50=${snap.byMethod.put.p50.toFixed(1)}ms p99=${snap.byMethod.put.p99.toFixed(1)}ms`,
    )
    // eslint-disable-next-line no-console
    console.info(
      `[topology-69]   get p50=${snap.byMethod.get.p50.toFixed(1)}ms p99=${snap.byMethod.get.p99.toFixed(1)}ms`,
    )
    // eslint-disable-next-line no-console
    console.info(
      `[topology-69]   ⚠ records run in-memory (sub-ms); only the WebDAV blob leg dominates p99`,
    )

    expect(snap.byMethod.put.count).toBeGreaterThan(0)
    expect(snap.byMethod.get.count).toBeGreaterThan(0)
  })
})

if (gate.enabled) {
  // eslint-disable-next-line no-console
  console.info(
    `[topology-69] Using webdav prefix=${PREFIX} vault=${VAULT}`,
  )
}
