import { describe, it, expect } from 'vitest'
import { NO_SNAPSHOTS } from '../src/snapshots/strategy.js'
import type { SnapshotMeta, RetentionPolicy, SnapshotIndex } from '../src/snapshots/strategy.js'
import { SnapshotNotFoundError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'
import { SnapshotEngine } from '../src/snapshots/engine.js'
import type { NoydbBundleStore } from '../src/types.js'

function makeMockStore(): NoydbBundleStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>()
  let versionCounter = 0
  return {
    kind: 'bundle' as const,
    name: 'mock',
    blobs,
    async readBundle(vaultId: string) {
      const bytes = blobs.get(vaultId)
      if (!bytes) return null
      return { bytes, version: `v${vaultId}` }
    },
    async writeBundle(vaultId: string, bytes: Uint8Array, _expectedVersion: string | null) {
      blobs.set(vaultId, bytes)
      return { version: `v${++versionCounter}` }
    },
    async deleteBundle(vaultId: string) { blobs.delete(vaultId) },
    async listBundles() {
      return [...blobs.keys()].map(k => ({ vaultId: k, version: `v${k}`, size: blobs.get(k)!.length }))
    },
  }
}

// Minimal mock vault for unit tests. writeNoydbBundle calls getBundleHandle(),
// dump(), and getPublicEnvelope() on the vault when invoked with empty opts.
// getBundleHandle() must return a valid 26-char Crockford base32 ULID.
function makeMockVault(name: string): unknown {
  // Static valid ULID-format handle (26 chars, Crockford base32 alphabet)
  const handle = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  return {
    name,
    async getBundleHandle() { return handle },
    async dump() { return JSON.stringify({ collections: {}, keyrings: {} }) },
    async load(_dumpJson: string) { /* no-op in unit tests */ },
    async getPublicEnvelope() { return undefined },
  }
}

describe('NO_SNAPSHOTS stub', () => {
  it('snapshot() throws NOT_ENABLED', async () => {
    await expect(NO_SNAPSHOTS.snapshot({}, 'user', {})).rejects.toThrow('withSnapshots')
  })

  it('listSnapshots() throws NOT_ENABLED', async () => {
    await expect(NO_SNAPSHOTS.listSnapshots('vault')).rejects.toThrow('withSnapshots')
  })

  it('restoreSnapshot() throws NOT_ENABLED', async () => {
    await expect(NO_SNAPSHOTS.restoreSnapshot({}, 'v1')).rejects.toThrow('withSnapshots')
  })
})

describe('SnapshotNotFoundError', () => {
  it('has correct code and message', () => {
    const err = new SnapshotNotFoundError('vault1__snap_000001')
    expect(err.code).toBe('SNAPSHOT_NOT_FOUND')
    expect(err.message).toContain('vault1__snap_000001')
    expect(err.version).toBe('vault1__snap_000001')
    expect(err).toBeInstanceOf(SnapshotNotFoundError)
  })
})

describe('Noydb.snapshot / listSnapshots / restoreSnapshot without snapshotStrategy', () => {
  it('snapshot() throws when strategy not configured', async () => {
    const db = await createNoydb({ store: memory(), user: 'u1', secret: 'pass' })
    await db.openVault('v1')
    await expect(db.snapshot('v1')).rejects.toThrow('withSnapshots')
  })

  it('listSnapshots() throws when strategy not configured', async () => {
    const db = await createNoydb({ store: memory(), user: 'u1', secret: 'pass' })
    await expect(db.listSnapshots('v1')).rejects.toThrow('withSnapshots')
  })

  it('restoreSnapshot() throws when strategy not configured', async () => {
    const db = await createNoydb({ store: memory(), user: 'u1', secret: 'pass' })
    await db.openVault('v1')
    await expect(db.restoreSnapshot('v1', 'v1__snap_000001')).rejects.toThrow('withSnapshots')
  })

  it('snapshot() throws ValidationError when vault not open', async () => {
    const db = await createNoydb({ store: memory(), user: 'u1', secret: 'pass' })
    await expect(db.snapshot('not-open')).rejects.toThrow('not open')
  })

  it('restoreSnapshot() throws ValidationError when vault not open', async () => {
    const db = await createNoydb({ store: memory(), user: 'u1', secret: 'pass' })
    await expect(db.restoreSnapshot('not-open', 'v1__snap_000001')).rejects.toThrow('not open')
  })
})

describe('SnapshotEngine.snapshot()', () => {
  it('returns SnapshotMeta with correct fields', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    const vault = makeMockVault('v1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = await engine.snapshot(vault as any, 'alice', { label: 'before-close' })

    expect(meta.version).toBe('v1__snap_000001')
    expect(meta.label).toBe('before-close')
    expect(meta.exportedBy).toBe('alice')
    expect(meta.integrity).toBe('verified')
    expect(meta.size).toBeGreaterThan(0)
    expect(meta.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('snapshot with no label/note omits those fields', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    const vault = makeMockVault('v1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = await engine.snapshot(vault as any, 'alice')

    expect(meta.label).toBeUndefined()
    expect(meta.note).toBeUndefined()
  })

  it('increments counter on each call', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    const vault = makeMockVault('v1')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m1 = await engine.snapshot(vault as any, 'alice')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m2 = await engine.snapshot(vault as any, 'alice')

    expect(m1.version).toBe('v1__snap_000001')
    expect(m2.version).toBe('v1__snap_000002')
    expect(store.blobs.has('v1__snap_000001')).toBe(true)
    expect(store.blobs.has('v1__snap_000002')).toBe(true)
  })

  it('writes a sidecar index blob', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    const vault = makeMockVault('v1')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await engine.snapshot(vault as any, 'alice', { label: 'snap1' })

    expect(store.blobs.has('v1__index')).toBe(true)
    const indexBytes = store.blobs.get('v1__index')!
    const index = JSON.parse(new TextDecoder().decode(indexBytes))
    expect(index.snapshots).toHaveLength(1)
    expect(index.snapshots[0].label).toBe('snap1')
    expect(index.nextCounter).toBe(2)
  })
})

describe('SnapshotEngine.listSnapshots()', () => {
  it('returns empty array when no snapshots exist', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    const list = await engine.listSnapshots('v1')
    expect(list).toEqual([])
  })

  it('returns snapshots newest-first', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    const vault = makeMockVault('v1')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m1 = await engine.snapshot(vault as any, 'alice', { label: 'first' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m2 = await engine.snapshot(vault as any, 'alice', { label: 'second' })

    const list = await engine.listSnapshots('v1')
    expect(list).toHaveLength(2)
    expect(list[0].version).toBe(m2.version) // newest first
    expect(list[1].version).toBe(m1.version)
  })
})
