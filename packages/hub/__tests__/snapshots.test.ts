import { describe, it, expect } from 'vitest'
import { NO_SNAPSHOTS } from '../src/snapshots/strategy.js'
import type { SnapshotMeta, RetentionPolicy, SnapshotIndex } from '../src/snapshots/strategy.js'
import { SnapshotNotFoundError } from '../src/errors.js'

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
