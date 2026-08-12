import { describe, it, expect } from 'vitest'
import { NO_SNAPSHOTS } from '../src/with-fork/snapshots/strategy.js'
import type { SnapshotMeta, RetentionPolicy, SnapshotIndex } from '../src/with-fork/snapshots/strategy.js'
import { SnapshotNotFoundError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { toMemory } from '../../to-memory/src/index.js'
import { SnapshotEngine } from '../src/with-fork/snapshots/engine.js'
import { withSnapshots } from '../src/with-fork/snapshots/active.js'
import type { NoydbPodStore } from '../src/kernel/types.js'

function makeMockStore(): NoydbPodStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>()
  const versions = new Map<string, string>()
  let versionCounter = 0
  return {
    kind: 'bundle' as const,
    name: 'mock',
    blobs,
    async readBundle(vaultId: string) {
      const bytes = blobs.get(vaultId)
      if (!bytes) return null
      return { bytes, version: versions.get(vaultId)! }
    },
    async writeBundle(vaultId: string, bytes: Uint8Array, _expectedVersion: string | null) {
      const version = `v${++versionCounter}`
      blobs.set(vaultId, bytes)
      versions.set(vaultId, version)
      return { version }
    },
    async deleteBundle(vaultId: string) {
      blobs.delete(vaultId)
      versions.delete(vaultId)
    },
    async listBundles() {
      return [...blobs.keys()].map(k => ({ vaultId: k, version: versions.get(k)!, size: blobs.get(k)!.length }))
    },
  }
}

// Minimal mock vault for unit tests. writePod calls getPodHandle(),
// dump(), getCover(), and _loadPodSigner() on the vault when invoked with
// empty opts. getPodHandle() must return a valid 26-char Crockford
// base32 ULID.
function makeMockVault(name: string): unknown {
  // Static valid ULID-format handle (26 chars, Crockford base32 alphabet)
  const handle = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  return {
    name,
    async getPodHandle() { return handle },
    async dump() { return JSON.stringify({ collections: {}, keyrings: {} }) },
    async load(_dumpJson: string) { /* no-op in unit tests */ },
    // No signer minted in these unit tests — pods stay unsigned (#943).
    async _loadPodSigner() { return null },
    async getCover() { return undefined },
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

describe('Noydb.snapshot / listSnapshots / restoreSnapshot without snapshotsStrategy', () => {
  it('snapshot() throws when strategy not configured', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'u1', secret: 'pass' })
    await db.openVault('v1')
    await expect(db.snapshot('v1')).rejects.toThrow('withSnapshots')
  })

  it('listSnapshots() throws when strategy not configured', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'u1', secret: 'pass' })
    await expect(db.listSnapshots('v1')).rejects.toThrow('withSnapshots')
  })

  it('restoreSnapshot() throws when strategy not configured', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'u1', secret: 'pass' })
    await db.openVault('v1')
    await expect(db.restoreSnapshot('v1', 'v1__snap_000001')).rejects.toThrow('withSnapshots')
  })

  it('snapshot() throws ValidationError when vault not open', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'u1', secret: 'pass' })
    await expect(db.snapshot('not-open')).rejects.toThrow('not open')
  })

  it('restoreSnapshot() throws ValidationError when vault not open', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'u1', secret: 'pass' })
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
    expect(list[0]!.version).toBe(m2.version) // newest first
    expect(list[1]!.version).toBe(m1.version)
  })
})

describe('SnapshotEngine retention', () => {
  it('keepLast:2 — 3rd snapshot deletes the oldest', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, { keepLast: 2 })
    const vault = makeMockVault('v1')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m1 = await engine.snapshot(vault as any, 'alice')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m2 = await engine.snapshot(vault as any, 'alice')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m3 = await engine.snapshot(vault as any, 'alice')

    // m1 should be pruned (oldest of 3, keepLast=2 means keep m2+m3)
    expect(store.blobs.has(m1.version)).toBe(false)
    expect(store.blobs.has(m2.version)).toBe(true)
    expect(store.blobs.has(m3.version)).toBe(true)

    const list = await engine.listSnapshots('v1')
    expect(list).toHaveLength(2)
    expect(list[0]!.version).toBe(m3.version)
    expect(list[1]!.version).toBe(m2.version)
  })

  it('prune:false — never deletes even when keepLast exceeded', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, { keepLast: 1, prune: false })
    const vault = makeMockVault('v1')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m1 = await engine.snapshot(vault as any, 'alice')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m2 = await engine.snapshot(vault as any, 'alice')

    // prune:false — nothing deleted even though keepLast:1 is exceeded
    expect(store.blobs.has(m1.version)).toBe(true)
    expect(store.blobs.has(m2.version)).toBe(true)
  })

  it('applyRetention directly — keepLast removes oldest entries', () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, { keepLast: 2 })

    const now = new Date().toISOString()
    const index = {
      snapshots: [
        { version: 'v1__snap_000001', exportedAt: now, exportedBy: 'a', size: 1, integrity: 'verified' as const },
        { version: 'v1__snap_000002', exportedAt: now, exportedBy: 'a', size: 1, integrity: 'verified' as const },
        { version: 'v1__snap_000003', exportedAt: now, exportedBy: 'a', size: 1, integrity: 'verified' as const },
      ],
      nextCounter: 4,
    }

    const toDelete = engine.applyRetention(index)

    expect(toDelete).toEqual(['v1__snap_000001'])
    expect(index.snapshots).toHaveLength(2)
    expect(index.snapshots[0]!.version).toBe('v1__snap_000002')
    expect(index.snapshots[1]!.version).toBe('v1__snap_000003')
  })

  it('applyRetention directly — prune:false returns empty even with excess', () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, { keepLast: 1, prune: false })

    const now = new Date().toISOString()
    const index = {
      snapshots: [
        { version: 'v1__snap_000001', exportedAt: now, exportedBy: 'a', size: 1, integrity: 'verified' as const },
        { version: 'v1__snap_000002', exportedAt: now, exportedBy: 'a', size: 1, integrity: 'verified' as const },
      ],
      nextCounter: 3,
    }

    const toDelete = engine.applyRetention(index)
    expect(toDelete).toEqual([])
    expect(index.snapshots).toHaveLength(2) // unchanged
  })
})

describe('SnapshotEngine.restoreSnapshot()', () => {
  it('throws SnapshotNotFoundError for unknown version', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    const vault = makeMockVault('v1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(engine.restoreSnapshot(vault as any, 'v1__snap_999999')).rejects.toThrow(SnapshotNotFoundError)
  })

  it('throws SnapshotNotFoundError with correct version field', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    const vault = makeMockVault('v1')
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await engine.restoreSnapshot(vault as any, 'v1__snap_999999')
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(SnapshotNotFoundError)
      expect((e as SnapshotNotFoundError).version).toBe('v1__snap_999999')
    }
  })

  it('throws SnapshotNotFoundError for cross-vault version key', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    const vault = makeMockVault('vault-a')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(engine.restoreSnapshot(vault as any, 'vault-b__snap_000001')).rejects.toThrow(SnapshotNotFoundError)
  })
})

describe('withSnapshots() factory', () => {
  it('returns a SnapshotsStrategy with all 3 methods', () => {
    const store = makeMockStore()
    const strategy = withSnapshots({ store })
    expect(typeof strategy.snapshot).toBe('function')
    expect(typeof strategy.listSnapshots).toBe('function')
    expect(typeof strategy.restoreSnapshot).toBe('function')
  })

  it('snapshot() delegates to SnapshotEngine', async () => {
    const store = makeMockStore()
    const strategy = withSnapshots({ store })
    const vault = makeMockVault('v1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = await strategy.snapshot(vault as any, 'alice', { label: 'test' })
    expect(meta.version).toBe('v1__snap_000001')
    expect(meta.label).toBe('test')
  })

  it('listSnapshots() delegates to SnapshotEngine', async () => {
    const store = makeMockStore()
    const strategy = withSnapshots({ store, retention: { keepLast: 5 } })
    const vault = makeMockVault('v1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await strategy.snapshot(vault as any, 'alice')
    const list = await strategy.listSnapshots('v1')
    expect(list).toHaveLength(1)
  })

  it('restoreSnapshot() throws SnapshotNotFoundError for unknown version', async () => {
    const store = makeMockStore()
    const strategy = withSnapshots({ store })
    const vault = makeMockVault('v1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(strategy.restoreSnapshot(vault as any, 'v1__snap_999999')).rejects.toThrow(SnapshotNotFoundError)
  })
})

describe('NO_SNAPSHOTS stub — autoSnapshot', () => {
  it('autoSnapshot() throws NOT_ENABLED', async () => {
    await expect(NO_SNAPSHOTS.autoSnapshot({}, 'user', {})).rejects.toThrow('withSnapshots')
  })
})

describe('SnapshotEngine.autoSnapshot — rolling key', () => {
  it('writes a single fixed key and overwrites it on repeat', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vault = makeMockVault('v1') as any

    const m1 = await engine.autoSnapshot(vault, 'user')
    const m2 = await engine.autoSnapshot(vault, 'user')

    expect(m1.version).toBe('v1__auto')
    expect(m2.version).toBe('v1__auto')
    expect(m1.auto).toBe(true)
    expect(m1.label).toBe('auto')
    expect([...store.blobs.keys()].sort()).toEqual(['v1__auto', 'v1__index'])
  })

  it('lists the auto snapshot first, ahead of the immutable pool', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vault = makeMockVault('v1') as any

    await engine.snapshot(vault, 'user', { label: 'manual-1' })
    await engine.autoSnapshot(vault, 'user')

    const list = await engine.listSnapshots('v1')
    expect(list[0]!.version).toBe('v1__auto')
    expect(list[1]!.label).toBe('manual-1')
  })

  it('is exempt from retention — auto survives keepLast:1 churn', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, { keepLast: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vault = makeMockVault('v1') as any

    await engine.autoSnapshot(vault, 'user')
    await engine.snapshot(vault, 'user', { label: 'm1' })
    await engine.snapshot(vault, 'user', { label: 'm2' })

    const list = await engine.listSnapshots('v1')
    expect(list.some(s => s.version === 'v1__auto')).toBe(true)
    expect(list.filter(s => !s.auto).length).toBe(1)
    expect(list.find(s => !s.auto)!.label).toBe('m2')
  })

  it('restores the auto snapshot by its key', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vault = makeMockVault('v1') as any
    await engine.autoSnapshot(vault, 'user')
    await expect(engine.restoreSnapshot(vault, 'v1__auto')).resolves.toBeUndefined()
  })
})

describe('withSnapshots — policy passthrough', () => {
  it('exposes the configured snapshotPolicy on the strategy', () => {
    const store = makeMockStore()
    const strat = withSnapshots({ store, snapshotPolicy: { mode: 'debounce', debounceMs: 5000 } })
    expect(strat.policy?.mode).toBe('debounce')
    expect(strat.policy?.debounceMs).toBe(5000)
  })

  it('omits policy when none is configured (manual default)', () => {
    const store = makeMockStore()
    const strat = withSnapshots({ store })
    expect(strat.policy).toBeUndefined()
  })

  it('delegates autoSnapshot to the engine', async () => {
    const store = makeMockStore()
    const strat = withSnapshots({ store })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vault = makeMockVault('vp') as any
    const meta = await strat.autoSnapshot(vault, 'user')
    expect(meta.version).toBe('vp__auto')
    expect(meta.auto).toBe(true)
  })
})

describe('Noydb auto-cadence wiring', () => {
  it('manual default wires no auto-snapshot on writes', async () => {
    const store = makeMockStore()
    const db = await createNoydb({ store: toMemory(), user: 'u', secret: 'pw', snapshotsStrategy: withSnapshots({ store }) })
    const v = await db.openVault('cad1')
    const c = v.collection<{ id: string; n: number }>('items')
    await c.put('a', { id: 'a', n: 1 })
    await new Promise(r => setTimeout(r, 20))
    const list = await db.listSnapshots('cad1')
    expect(list.find(s => s.auto)).toBeUndefined()
    db.close()
  })

  it('debounce policy auto-snapshots after a write and is restorable', async () => {
    const store = makeMockStore()
    const db = await createNoydb({
      store: toMemory(), user: 'u', secret: 'pw',
      snapshotsStrategy: withSnapshots({ store, snapshotPolicy: { mode: 'debounce', debounceMs: 10, onUnload: false } }),
    })
    const v = await db.openVault('cad2')
    const c = v.collection<{ id: string; n: number }>('items')
    await c.put('a', { id: 'a', n: 1 })
    // Poll for the debounced auto-snapshot to land — robust under load where a
    // fixed sleep can race the timer.
    let auto: { version: string } | undefined
    for (let i = 0; i < 50 && !auto; i++) {
      await new Promise(r => setTimeout(r, 20))
      auto = (await db.listSnapshots('cad2')).find(s => s.auto)
    }
    expect(auto).toBeDefined()
    expect(auto!.version).toBe('cad2__auto')
    db.close()
  })

  it('retries on the next interval tick when an auto-snapshot fails', async () => {
    let calls = 0
    // Custom strategy: autoSnapshot always throws — the vault must stay pending
    // and be retried on each interval tick.
    const failingStrategy = {
      async snapshot() { throw new Error('unused') },
      async listSnapshots() { return [] },
      async restoreSnapshot() { /* unused */ },
      async autoSnapshot() { calls++; throw new Error('boom') },
      policy: { mode: 'interval' as const, intervalMs: 15, onUnload: false },
    }
    const db = await createNoydb({
      store: toMemory(), user: 'u', secret: 'pw',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      snapshotsStrategy: failingStrategy as any,
    })
    const v = await db.openVault('cad4')
    const c = v.collection<{ id: string; n: number }>('items')
    await c.put('a', { id: 'a', n: 1 })
    // Poll until we've seen at least two attempts (proof of retry after failure).
    for (let i = 0; i < 50 && calls < 2; i++) await new Promise(r => setTimeout(r, 15))
    expect(calls).toBeGreaterThanOrEqual(2)
    db.close()
  })

  it('close() stops the scheduler (no auto-snapshot after close)', async () => {
    const store = makeMockStore()
    const db = await createNoydb({
      store: toMemory(), user: 'u', secret: 'pw',
      snapshotsStrategy: withSnapshots({ store, snapshotPolicy: { mode: 'debounce', debounceMs: 50, onUnload: false } }),
    })
    const v = await db.openVault('cad3')
    const c = v.collection<{ id: string; n: number }>('items')
    await c.put('a', { id: 'a', n: 1 })
    db.close()
    await new Promise(r => setTimeout(r, 80))
    expect(store.blobs.has('cad3__auto')).toBe(false)
  })
})
