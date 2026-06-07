/**
 * Showcase 96 — automatic snapshot cadence (rolling auto key)
 *
 * What you'll learn
 * ─────────────────
 *   1. `withSnapshots({ snapshotPolicy })` fires automatic whole-vault
 *      snapshots on a debounce cadence after writes.
 *   2. Auto-snapshots write a single rolling `<vault>__auto` key — they never
 *      accumulate and never evict labeled on-demand checkpoints.
 *   3. Both the rolling auto snapshot and labeled checkpoints are restorable.
 *
 * Why it matters
 * ──────────────
 * Local-first apps want periodic durable backups without hand-rolling a timer,
 * dirty-tracking, and flush-on-unload — while preserving the integrity-verified
 * on-demand checkpoints that mark "a version worth keeping".
 *
 * Prerequisites
 * ─────────────
 * - Showcase 93 (withSnapshots checkpoint/restore).
 *
 * What to read next
 * ─────────────────
 *   - docs/subsystems/snapshots.md (§ Automatic cadence, § S3 bundle store)
 *   - docs/superpowers/specs/2026-06-07-snapshots-auto-cadence-and-s3-bundle-design.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → snapshots
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withSnapshots } from '@noy-db/hub/snapshots'
import { memory } from '@noy-db/to-memory'

// A reusable in-memory bundle store for the snapshot destination.
function memoryBundleStore() {
  const blobs = new Map<string, Uint8Array>()
  const versions = new Map<string, string>()
  let seq = 0
  return {
    kind: 'bundle' as const,
    name: 'mem-bundle',
    async readBundle(id: string) {
      const bytes = blobs.get(id)
      return bytes ? { bytes, version: versions.get(id)! } : null
    },
    async writeBundle(id: string, bytes: Uint8Array, _expected: string | null) {
      const version = `v${++seq}`
      blobs.set(id, bytes); versions.set(id, version)
      return { version }
    },
    async deleteBundle(id: string) { blobs.delete(id); versions.delete(id) },
    async listBundles() {
      return [...blobs.keys()].map(k => ({ vaultId: k, version: versions.get(k)!, size: blobs.get(k)!.length }))
    },
  }
}

describe('Showcase 96 — automatic snapshot cadence', () => {
  it('auto-snapshots on a debounce cadence, leaving labeled checkpoints intact', async () => {
    const store = memoryBundleStore()
    const db = await createNoydb({
      store: memory(), user: 'acct', secret: 'pw-96',
      snapshotStrategy: withSnapshots({
        store,
        snapshotPolicy: { mode: 'debounce', debounceMs: 10, onUnload: false },
      }),
    })
    const vault = await db.openVault('ledger')
    const entries = vault.collection<{ id: string; amount: number }>('entries')

    // A deliberate, labeled checkpoint — the "version worth keeping".
    await entries.put('e1', { id: 'e1', amount: 100 })
    await db.snapshot('ledger', { label: 'before-May-close' })

    // Ongoing edits drive the automatic cadence.
    await entries.put('e2', { id: 'e2', amount: 250 })
    await new Promise(r => setTimeout(r, 50)) // let the debounce fire

    const list = await db.listSnapshots('ledger')
    const auto = list.find(s => s.auto)
    const labeled = list.find(s => s.label === 'before-May-close')

    expect(auto?.version).toBe('ledger__auto')   // rolling auto snapshot exists
    expect(labeled).toBeDefined()                // labeled checkpoint untouched by cadence

    // The rolling auto snapshot restores like any other.
    await expect(db.restoreSnapshot('ledger', 'ledger__auto')).resolves.toBeUndefined()
    db.close()
  })
})
