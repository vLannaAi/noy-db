/**
 * Showcase 05 — Storage: routing across two backends
 *
 * What you'll learn
 * ─────────────────
 * `routeStore({ default, routes })` from `@noy-db/hub` composes
 * multiple `NoydbStore`s into a single virtual store. Records land
 * in different backends based on collection name. The hub sees one
 * store; the operator gets per-collection placement control.
 *
 * Why it matters
 * ──────────────
 * Real production topologies don't pick one backend — they pick the
 * right backend per workload. Big-record blobs to S3, hot records to
 * DynamoDB, archive records to a cold tier. `routeStore` is the seam
 * that lets you pick all of the above without writing routing code
 * in your app.
 *
 * Prerequisites
 * ─────────────
 * - Showcases 01-04 (the individual backends being routed).
 *
 * What to read next
 * ─────────────────
 *   - showcase 49-topology-team-routing (a full team workflow built on this)
 *   - docs/subsystems/routing.md (full routing surface)
 *   - packages/hub/src/store/route-store.ts (the implementation, ~250 LOC)
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → query-basics (always-on) — routing lives
 * in core today; an opt-in `withRouting()` is a planned extraction.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, routeStore } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; amount: number }
interface AuditEntry { id: string; when: string; what: string }

describe('Showcase 05 — Storage: routing across two backends', () => {
  it('routes named collections to different underlying stores', async () => {
    // Two physically separate memory stores stand in for "primary"
    // and "audit" backends. In production these would be Dynamo + S3
    // or hot-tier + cold-tier.
    const primary = memory()
    const audit = memory()

    const store = routeStore({
      default: primary,
      routes: {
        audit: audit, // The "audit" collection lives here, not in primary.
      },
    })

    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-routing-passphrase-2026',
    })
    const vault = await db.openVault('demo')

    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })
    await vault.collection<AuditEntry>('audit').put('ev-1', { id: 'ev-1', when: '2026-04-26', what: 'invoice created' })

    // Each backend has the records for ITS collection only.
    const primaryColls = await primary.list('demo', 'invoices')
    const auditColls = await audit.list('demo', 'audit')
    expect(primaryColls).toEqual(['inv-1'])
    expect(auditColls).toEqual(['ev-1'])

    // Conversely, each backend does NOT have the OTHER collection's records.
    expect(await primary.list('demo', 'audit')).toEqual([])
    expect(await audit.list('demo', 'invoices')).toEqual([])

    db.close()
  })

  it('queries see one logical store regardless of physical placement', async () => {
    const primary = memory()
    const audit = memory()
    const store = routeStore({ default: primary, routes: { audit: audit } })

    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-routing-passphrase-2026',
    })
    const vault = await db.openVault('demo')

    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 50 })
    await vault.collection<Invoice>('invoices').put('inv-2', { id: 'inv-2', amount: 200 })
    await vault.collection<AuditEntry>('audit').put('ev-1', { id: 'ev-1', when: '2026-04-26', what: 'a' })
    await vault.collection<AuditEntry>('audit').put('ev-2', { id: 'ev-2', when: '2026-04-26', what: 'b' })

    const invoices = await vault.collection<Invoice>('invoices').list()
    const events = await vault.collection<AuditEntry>('audit').list()
    expect(invoices.map((r) => r.id).sort()).toEqual(['inv-1', 'inv-2'])
    expect(events.map((r) => r.id).sort()).toEqual(['ev-1', 'ev-2'])

    db.close()
  })

  it('blob storage can be routed to a separate backend via the `blobs` option', async () => {
    // The `blobs` option is the canonical "metadata in fast store,
    // chunks in cheap store" pattern. We don't exercise the blobs
    // subsystem here (that's showcase 08) — this test only verifies
    // the route shape compiles + accepts the option.
    const records = memory()
    const blobs = memory()
    const store = routeStore({ default: records, blobs })
    expect(store).toBeDefined()
    expect(typeof store.put).toBe('function')
    expect(typeof store.get).toBe('function')
  })
})
