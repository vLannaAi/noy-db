/**
 * Showcase 123 — klum-db scoped surface sync: proposeSurface / agreeSurface /
 * exportSurface / applySurface + cadence (FR-7)
 *
 * What you'll learn
 * ─────────────────
 * A surface is a named bilateral agreement that allows a SCOPED slice of data
 * to flow between two vaults — only named collections, optionally only named
 * fields, in a declared direction, with a conflict policy:
 *
 *   1. `proposeSurface(smv, def, proposedBy, now)` — Party A files a proposed
 *      surface into the shared StateManagementVault.
 *   2. `agreeSurface(smv, surfaceId, agreedBy, now)` — Party B flips it to
 *      `'agreed'` (the only status that allows data to flow).
 *   3. `exportSurface(vault, surface)` / `applySurface(vault, surface, …)`
 *      (via `lobby.exportSurface` / `lobby.applySurface`) — Party A exports
 *      exactly the surface's collection slice with optional field projection;
 *      Party B merges it under the surface's conflict policy.
 *   4. `isSurfaceDue(surface, now)` / `markSynced(smv, id, now)` — a pure
 *      cadence predicate + the post-sync stamp. No shared clock, no side effects
 *      in the predicate.
 *
 * Asserts
 * ───────
 * - Only surface-declared collection (`invoices`) reached the receiver vault.
 * - A non-surface collection (`confidential`) did NOT travel.
 * - A non-surface field (`secret`) is absent from the merged record (field
 *   projection: only `id` + `amount` were declared in the surface).
 * - `isSurfaceDue` returns true on a never-synced surface and false after
 *   `markSynced` stamps the next cadence window.
 *
 * Spec mapping
 * ────────────
 * features.yaml → scoped-sync-surface
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import {
  createLobby,
  proposeSurface,
  agreeSurface,
  isSurfaceDue,
  markSynced,
} from '@klum-db/lobby'

describe('Showcase 123 — klum-db scoped surface sync', () => {
  it(
    'propose/agree → exportSurface with field projection → applySurface → cadence stamps',
    async () => {
      // ── Shared StateManagementVault store ─────────────────────────────────
      // Both parties share the same store so the SMV record is visible to both.
      const sharedStore = memory()
      const smvDb = await createNoydb({ store: sharedStore, user: 'smv-admin', secret: 'smv-admin-2026' })
      const lobby = createLobby(smvDb)
      const smv = await lobby.openStateManagementVault()

      // ── SOURCE vault (Party A) ─────────────────────────────────────────────
      const srcStore = memory()
      const srcDb = await createNoydb({ store: srcStore, user: 'party-a', secret: 'party-a-2026' })
      const srcVault = await srcDb.openVault('source-vault')

      // Seed: invoices (on-surface) + confidential (off-surface)
      await srcVault.collection<{ id: string; amount: number; secret: string }>('invoices').put(
        'inv-1', { id: 'inv-1', amount: 1000, secret: 'internal-note' },
      )
      await srcVault.collection<{ id: string; amount: number; secret: string }>('invoices').put(
        'inv-2', { id: 'inv-2', amount: 250, secret: 'another-note' },
      )
      await srcVault.collection<{ id: string; payload: string }>('confidential').put(
        'conf-1', { id: 'conf-1', payload: 'eyes-only' },
      )

      // ── RECEIVER vault (Party B) ───────────────────────────────────────────
      const recvStore = memory()
      const recvDb = await createNoydb({ store: recvStore, user: 'party-b', secret: 'party-b-2026' })
      const recvVault = await recvDb.openVault('receiver-vault')

      // ── 1. Party A proposes a surface ─────────────────────────────────────
      const T0 = 1_000_000
      const surface = await proposeSurface(
        smv,
        {
          id: 'surf-123',
          collections: ['invoices'],
          // Field projection: only id + amount; `secret` is excluded
          fields: { invoices: ['id', 'amount'] },
          direction: 'push',
          conflictPolicy: { strategy: 'take-incoming' },
          cadenceMs: 60_000, // sync every 60s
        },
        'party-a',
        T0,
      )

      expect(surface.status).toBe('proposed')
      expect(surface.proposedBy).toBe('party-a')

      // A proposed surface cannot be exported yet (SurfaceStateError)
      const { exportSurface: exportFnEarly } = await import('@klum-db/lobby')
      await expect(
        exportFnEarly(srcVault, surface),
      ).rejects.toThrow() // SurfaceStateError — surface must be 'agreed'

      // ── 2. Party B agrees ─────────────────────────────────────────────────
      const agreed = await agreeSurface(smv, 'surf-123', 'party-b', T0)
      expect(agreed.status).toBe('agreed')
      expect(agreed.agreedBy).toBe('party-b')

      // ── 3. Check cadence: never-synced 'agreed' surface is always due ─────
      expect(isSurfaceDue(agreed, T0)).toBe(true)

      // ── 4. Export the surface from Party A's vault ────────────────────────
      // Note: exportSurface/applySurface are standalone; we also expose them
      // on Lobby for convenience. Here we use them both ways.
      const { exportSurface: exportSurfaceFn, applySurface: applySurfaceFn } = await import('@klum-db/lobby')

      const { bundleBytes, transferKey } = await exportSurfaceFn(srcVault, agreed)
      expect(bundleBytes.byteLength).toBeGreaterThan(0)
      expect(transferKey.byteLength).toBe(32)

      // ── 5. Apply the surface bundle into Party B's receiver vault ─────────
      const mergeReport = await applySurfaceFn(recvVault, agreed, bundleBytes, transferKey)
      expect(mergeReport.summary.inserted).toBe(2) // inv-1 + inv-2
      expect(mergeReport.summary.total).toBe(2)

      // ── 6. Assert: only 'invoices' reached the receiver ───────────────────
      const inv1 = await recvVault.collection<{ id: string; amount: number; secret?: string }>('invoices').get('inv-1')
      const inv2 = await recvVault.collection<{ id: string; amount: number; secret?: string }>('invoices').get('inv-2')
      expect(inv1?.amount).toBe(1000)
      expect(inv2?.amount).toBe(250)

      // ASSERT: 'secret' field was projected out — not present in the merged record
      expect(inv1?.secret).toBeUndefined()
      expect(inv2?.secret).toBeUndefined()

      // ASSERT: 'confidential' collection did NOT travel (not in surface.collections)
      const conf = await recvVault.collection<{ id: string }>('confidential').get('conf-1')
      expect(conf).toBeNull()

      // ── 7. markSynced stamps the cadence window ────────────────────────────
      const T1 = T0 + 1000 // 1 second after
      const afterSync = await markSynced(smv, 'surf-123', T1)
      expect(afterSync.lastSyncAt).toBe(T1)
      expect(afterSync.nextSyncDueAt).toBe(T1 + 60_000)

      // Now isSurfaceDue returns false (next window hasn't elapsed)
      expect(isSurfaceDue(afterSync, T1 + 1)).toBe(false)
      // And true once the cadence window has elapsed
      expect(isSurfaceDue(afterSync, T1 + 60_000)).toBe(true)
    },
  )

  it('Lobby.exportSurface / applySurface convenience methods match standalone functions', async () => {
    const sharedStore = memory()
    const smvDb = await createNoydb({ store: sharedStore, user: 'smv-b', secret: 'smv-b-2026' })
    const lobby = createLobby(smvDb)
    const smv = await lobby.openStateManagementVault()

    // Source vault registered on the lobby's noydb instance
    const srcVault = await smvDb.openVault('src-b')
    await srcVault.collection<{ id: string; v: number }>('data').put('r1', { id: 'r1', v: 42 })

    // Receiver via a separate db
    const recvStore = memory()
    const recvDb = await createNoydb({ store: recvStore, user: 'recv-b', secret: 'recv-b-2026' })
    await recvDb.openVault('recv-b')

    const agreed = await agreeSurface(
      smv,
      (await proposeSurface(
        smv,
        { collections: ['data'], direction: 'push', conflictPolicy: { strategy: 'take-incoming' } },
        'smv-b', Date.now(),
      )).id,
      'recv-b', Date.now(),
    )

    // Lobby convenience method
    const { bundleBytes, transferKey } = await lobby.exportSurface('src-b', agreed)
    expect(bundleBytes.byteLength).toBeGreaterThan(0)

    // Apply via standalone function directly on receiver vault
    const { applySurface: applyFn } = await import('@klum-db/lobby')
    const recvVault = await recvDb.openVault('recv-b')
    const rpt = await applyFn(recvVault, agreed, bundleBytes, transferKey)
    expect(rpt.summary.inserted).toBe(1)

    const r1 = await recvVault.collection<{ id: string; v: number }>('data').get('r1')
    expect(r1?.v).toBe(42)
  })
})
