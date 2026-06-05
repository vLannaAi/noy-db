import { describe, it, expect } from 'vitest'
import { NO_SNAPSHOTS } from '../src/snapshots/strategy.js'
import type { SnapshotMeta, RetentionPolicy, SnapshotIndex } from '../src/snapshots/strategy.js'
import { SnapshotNotFoundError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'

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
