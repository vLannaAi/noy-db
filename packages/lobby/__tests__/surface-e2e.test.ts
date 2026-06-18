/**
 * Two-party Surface E2E acceptance test (FR-7 Task 5).
 *
 * Acceptance criteria:
 *  - Party A proposes a PUSH surface (clients, fields:{clients:['name']}, cadenceMs:60000).
 *  - Party B agrees.
 *  - A exports → B applies.
 *  - Receiver: clients have name only (no phone); secret collection absent.
 *  - markSynced → isSurfaceDue false → advance now past nextSyncDueAt → due true.
 *  - A suspended surface is NOT due.
 *
 * This is the full scoped+projected sync proof end-to-end across two parties.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { StateManagementVault } from '../src/federation/state-vault.js'
import {
  proposeSurface,
  agreeSurface,
  exportSurface,
  applySurface,
  markSynced,
  isSurfaceDue,
} from '../src/interchange/surface.js'
import type { SurfaceDefinition } from '../src/interchange/surface.js'

// ─── Fixture types ────────────────────────────────────────────────────────────

interface Client { id: string; name: string; phone: string }
interface Secret { id: string; data: string }

// ─── Full E2E walkthrough ─────────────────────────────────────────────────────

describe('Surface E2E — two-party scoped+projected sync (FR-7)', () => {
  it('full acceptance walkthrough: propose → agree → export → apply → cadence', async () => {
    const NOW = 1_000_000
    const CADENCE = 60_000

    // ── 1. Shared state vault (both parties use the same store for the SMV)
    const sharedStore = memory()
    const dbA = await createNoydb({ store: sharedStore, user: 'partyA', encrypt: false })
    const dbB = await createNoydb({ store: sharedStore, user: 'partyB', encrypt: false })
    const smvA = await StateManagementVault.open(dbA)
    const smvB = await StateManagementVault.open(dbB)

    // ── 2. Party A proposes a PUSH surface (clients, name only, cadence 60s)
    const def: SurfaceDefinition = {
      id: 'e2e-surf-1',
      collections: ['clients'],
      fields: { clients: ['name'] },
      direction: 'push',
      conflictPolicy: { strategy: 'take-incoming' },
      cadenceMs: CADENCE,
    }
    const proposed = await proposeSurface(smvA, def, 'partyA', NOW)
    expect(proposed.status).toBe('proposed')
    expect(proposed.cadenceMs).toBe(CADENCE)

    // ── 3. Party B agrees
    // Use a fresh Noydb to prove persistence (eager-cache note: fresh open reads from store)
    const dbB2 = await createNoydb({ store: sharedStore, user: 'partyB', encrypt: false })
    const smvB2 = await StateManagementVault.open(dbB2)
    const agreed = await agreeSurface(smvB2, proposed.id, 'partyB', NOW + 1_000)
    expect(agreed.status).toBe('agreed')
    expect(agreed.agreedBy).toBe('partyB')

    // ── 4. Party A's data vault: clients + secret (NOT in surface)
    const srcDb = await createNoydb({ store: memory(), user: 'srcPartyA', secret: 'src-secret-xr7' })
    const srcVault = await srcDb.openVault('partyA-data')
    const clientsColl = srcVault.collection<Client>('clients')
    await clientsColl.put('c1', { id: 'c1', name: 'Alice', phone: '+1-555-0101' })
    await clientsColl.put('c2', { id: 'c2', name: 'Bob', phone: '+1-555-0202' })
    const secretColl = srcVault.collection<Secret>('secret')
    await secretColl.put('s1', { id: 's1', data: 'CONFIDENTIAL' })

    // ── 5. Export (Party A side)
    const { bundleBytes, transferKey } = await exportSurface(srcVault, agreed)
    expect(bundleBytes).toBeInstanceOf(Uint8Array)
    expect(bundleBytes.length).toBeGreaterThan(0)
    expect(transferKey.length).toBe(32)

    // ── 6. Apply (Party B side — fresh Noydb receiver)
    const recvDb = await createNoydb({ store: memory(), user: 'partyB-recv', secret: 'recv-secret-y9k' })
    const recvVault = await recvDb.openVault('partyB-data')
    const report = await applySurface(recvVault, agreed, bundleBytes, transferKey)

    // ── 7. Acceptance assertions: scoped + projected
    expect(report.summary.inserted).toBe(2)

    // clients: only id + name — phone must be absent
    const c1 = await recvVault.collection<Record<string, unknown>>('clients').get('c1')
    expect(c1).not.toBeNull()
    expect(c1!['id']).toBe('c1')
    expect(c1!['name']).toBe('Alice')
    expect(c1!['phone']).toBeUndefined()   // projected out

    const c2 = await recvVault.collection<Record<string, unknown>>('clients').get('c2')
    expect(c2).not.toBeNull()
    expect(c2!['name']).toBe('Bob')
    expect(c2!['phone']).toBeUndefined()   // projected out

    // secret: absent — outside the surface, never leaves
    const secretList = await recvVault.collection<Secret>('secret').list()
    expect(secretList).toHaveLength(0)

    // ── 8. Cadence: markSynced flips isSurfaceDue false then true
    // Before markSynced: surface is agreed+cadence+never-synced → due
    expect(isSurfaceDue(agreed, NOW + 2_000)).toBe(true)

    // markSynced stamps lastSyncAt + nextSyncDueAt.
    // Use smvB2: it is the SMV that agreed the surface, so its cache has
    // the status:'agreed' row (eager-cache note: each Noydb instance has
    // its own in-memory collection cache; use the instance that last wrote
    // the agreed status so markSynced merges from the correct basis).
    const syncTime = NOW + 2_000
    await markSynced(smvB2, agreed.id, syncTime)

    // Read the updated surface from a fresh Noydb (force a store read, not cache)
    const dbA2 = await createNoydb({ store: sharedStore, user: 'partyA', encrypt: false })
    const smvA2 = await StateManagementVault.open(dbA2)
    const afterSync = await smvA2.getSurface(agreed.id)
    expect(afterSync).not.toBeNull()
    expect(afterSync!.lastSyncAt).toBe(syncTime)
    expect(afterSync!.nextSyncDueAt).toBe(syncTime + CADENCE)

    // Not due right after sync
    expect(isSurfaceDue(afterSync!, syncTime)).toBe(false)
    expect(isSurfaceDue(afterSync!, syncTime + CADENCE - 1)).toBe(false)

    // Due once now advances past nextSyncDueAt
    expect(isSurfaceDue(afterSync!, syncTime + CADENCE)).toBe(true)
    expect(isSurfaceDue(afterSync!, syncTime + CADENCE + 5_000)).toBe(true)

    // ── 9. Suspended surface is NOT due
    // Use smvA2 here — it has the most recent (markSynced) row in its cache
    // after the getSurface call above, so updateSurface merges from the correct basis.
    await smvA2.updateSurface(agreed.id, { status: 'suspended' })
    const suspended = await smvA2.getSurface(agreed.id)
    expect(suspended!.status).toBe('suspended')
    // even though now is past nextSyncDueAt, a suspended surface must not fire
    expect(isSurfaceDue(suspended!, syncTime + CADENCE + 10_000)).toBe(false)
  })

  it('secondary: smvB can read the agreed surface that smvA wrote (shared store)', async () => {
    const sharedStore = memory()
    const dbA = await createNoydb({ store: sharedStore, user: 'partyA', encrypt: false })
    const smvA = await StateManagementVault.open(dbA)

    const def: SurfaceDefinition = {
      id: 'e2e-surf-2',
      collections: ['orders'],
      direction: 'bidi',
      conflictPolicy: { strategy: 'lww-by-ts' },
      cadenceMs: 30_000,
    }

    await proposeSurface(smvA, def, 'partyA', 2_000_000)

    // Party B on the same store
    const dbB = await createNoydb({ store: sharedStore, user: 'partyB', encrypt: false })
    const smvB = await StateManagementVault.open(dbB)
    const seen = await smvB.getSurface('e2e-surf-2')
    expect(seen?.status).toBe('proposed')
    expect(seen?.cadenceMs).toBe(30_000)

    const agreed = await agreeSurface(smvB, 'e2e-surf-2', 'partyB', 2_001_000)
    expect(agreed.status).toBe('agreed')
    expect(agreed.direction).toBe('bidi')
  })
})
