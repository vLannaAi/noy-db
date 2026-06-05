/**
 * Showcase 93 — Snapshot lifecycle (withSnapshots)
 *
 * What you'll learn
 * ─────────────────
 * `withSnapshots({ store })` adds `db.snapshot()`, `db.listSnapshots()`,
 * and `db.restoreSnapshot()` to a vault. Snapshots are whole-vault
 * `.noydb` bundles stored in any `NoydbBundleStore`-compatible adapter.
 * Restore runs `verifyBackupIntegrity()` automatically — tampered bytes
 * throw `BackupCorruptedError` before any data reaches the vault.
 *
 * Why it matters
 * ──────────────
 * "Save before year-close" is a common accounting pattern. Without
 * snapshots, an app must manually serialize the vault, version it, and
 * verify integrity on restore. This subsystem reduces that to 3 method
 * calls while keeping correctness (tamper-evidence) as a library guarantee.
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → with-snapshots
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, SnapshotNotFoundError } from '@noy-db/hub'
import { withSnapshots } from '@noy-db/hub/snapshots'
import { memory } from '@noy-db/to-memory'

// A minimal NoydbBundleStore backed by a plain Map.
// Real apps pass to-drive(), to-webdav(), etc. here.
function makeMemoryBundleStore() {
  const blobs = new Map<string, { bytes: Uint8Array; version: string }>()
  let seq = 0
  return {
    kind: 'bundle' as const,
    name: 'memory-bundle',
    async readBundle(vaultId: string) {
      return blobs.get(vaultId) ?? null
    },
    async writeBundle(vaultId: string, bytes: Uint8Array, _expectedVersion: string | null) {
      const version = `v${++seq}`
      blobs.set(vaultId, { bytes, version })
      return { version }
    },
    async deleteBundle(vaultId: string) { blobs.delete(vaultId) },
    async listBundles() {
      return [...blobs.entries()].map(([k, v]) => ({ vaultId: k, version: v.version, size: v.bytes.length }))
    },
  }
}

interface Invoice {
  id: string
  amount: number
  status: 'open' | 'closed'
}

describe('Showcase 93 — withSnapshots()', () => {
  it('snapshot → modify → restoreSnapshot brings data back', async () => {
    const bundleStore = makeMemoryBundleStore()
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'pass-alice',
      snapshotStrategy: withSnapshots({ store: bundleStore }),
    })

    await db.openVault('acct')
    const inv = db.vault('acct').collection<Invoice>('invoices')

    // Seed two invoices
    await inv.put('inv-1', { id: 'inv-1', amount: 1000, status: 'open' })
    await inv.put('inv-2', { id: 'inv-2', amount: 2000, status: 'open' })

    // Take a snapshot (checkpoint before year-close)
    const snap = await db.snapshot('acct', { label: 'before-year-close' })
    expect(snap.version).toMatch(/^acct__snap_/)
    expect(snap.label).toBe('before-year-close')
    expect(snap.exportedBy).toBe('alice')
    expect(snap.integrity).toBe('verified')

    // Modify: close both invoices
    await inv.put('inv-1', { id: 'inv-1', amount: 1000, status: 'closed' })
    await inv.put('inv-2', { id: 'inv-2', amount: 2000, status: 'closed' })
    expect((await inv.get('inv-1'))?.status).toBe('closed')

    // Restore the snapshot.
    // After restore, vault.load() clears the collection cache — re-obtain
    // the collection handle so reads go through the freshly-loaded state.
    await db.restoreSnapshot('acct', snap.version)
    const invAfter = db.vault('acct').collection<Invoice>('invoices')

    // Data is back to pre-close state
    const restored1 = await invAfter.get('inv-1')
    const restored2 = await invAfter.get('inv-2')
    expect(restored1?.status).toBe('open')
    expect(restored2?.status).toBe('open')
  })

  it('listSnapshots() returns newest-first metadata without downloading blobs', async () => {
    const bundleStore = makeMemoryBundleStore()
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'pass-alice',
      snapshotStrategy: withSnapshots({ store: bundleStore }),
    })

    await db.openVault('acct')
    const inv = db.vault('acct').collection<Invoice>('invoices')
    await inv.put('inv-1', { id: 'inv-1', amount: 1000, status: 'open' })

    await db.snapshot('acct', { label: 'snap-1' })
    await db.snapshot('acct', { label: 'snap-2' })
    await db.snapshot('acct', { label: 'snap-3' })

    const list = await db.listSnapshots('acct')
    expect(list).toHaveLength(3)
    expect(list[0].label).toBe('snap-3') // newest first
    expect(list[1].label).toBe('snap-2')
    expect(list[2].label).toBe('snap-1')
  })

  it('keepLast:2 retention prunes oldest snapshot on 3rd write', async () => {
    const bundleStore = makeMemoryBundleStore()
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'pass-alice',
      snapshotStrategy: withSnapshots({
        store: bundleStore,
        retention: { keepLast: 2 },
      }),
    })

    await db.openVault('acct')
    const inv = db.vault('acct').collection<Invoice>('invoices')
    await inv.put('inv-1', { id: 'inv-1', amount: 100, status: 'open' })

    const s1 = await db.snapshot('acct', { label: '1' })
    const s2 = await db.snapshot('acct', { label: '2' })
    const s3 = await db.snapshot('acct', { label: '3' })

    const list = await db.listSnapshots('acct')
    expect(list).toHaveLength(2)
    expect(list.map((s: { label?: string }) => s.label)).toEqual(['3', '2'])

    // s1 was pruned — restoring it should throw
    await expect(db.restoreSnapshot('acct', s1.version)).rejects.toThrow(SnapshotNotFoundError)

    // s2 and s3 still restorable
    await expect(db.restoreSnapshot('acct', s2.version)).resolves.toBeUndefined()
    await expect(db.restoreSnapshot('acct', s3.version)).resolves.toBeUndefined()
  })

  it('restoreSnapshot throws SnapshotNotFoundError for unknown version', async () => {
    const bundleStore = makeMemoryBundleStore()
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'pass-alice',
      snapshotStrategy: withSnapshots({ store: bundleStore }),
    })
    await db.openVault('acct')
    await expect(
      db.restoreSnapshot('acct', 'acct__snap_999999'),
    ).rejects.toThrow(SnapshotNotFoundError)
  })
})
