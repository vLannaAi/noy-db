/**
 * Surface cadence scheduler (FR-7 Task 5).
 *
 * Tests three layers:
 *  1. Pure due-check: `isSurfaceDue(surface, now)` — deterministic, no Date.now().
 *  2. `listDueSurfaces(surfaces, now)` — filter helper.
 *  3. `markSynced(smv, id, now)` — stamps lastSyncAt + nextSyncDueAt in the SMV.
 *  4. `SurfaceCadenceScheduler` — thin setInterval driver (vi.useFakeTimers).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { StateManagementVault } from '../src/federation/state-vault.js'
import type { SurfaceRow } from '../src/federation/types.js'
import {
  isSurfaceDue,
  listDueSurfaces,
  markSynced,
  SurfaceCadenceScheduler,
} from '../src/interchange/surface.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_000_000
const CADENCE = 60_000

function makeAgreedSurface(overrides: Partial<SurfaceRow> = {}): SurfaceRow {
  return {
    id: 'surf-cadence-1',
    collections: ['clients'],
    direction: 'push',
    conflictPolicy: { strategy: 'take-incoming' },
    cadenceMs: CADENCE,
    status: 'agreed',
    proposedBy: 'partyA',
    agreedBy: 'partyB',
    createdAt: 900_000,
    ...overrides,
  }
}

// ─── isSurfaceDue ─────────────────────────────────────────────────────────────

describe('isSurfaceDue — pure due-check (deterministic)', () => {
  it('never-synced agreed surface with cadence is due', () => {
    const surface = makeAgreedSurface({ lastSyncAt: undefined, nextSyncDueAt: undefined })
    expect(isSurfaceDue(surface, NOW)).toBe(true)
  })

  it('synced surface with nextSyncDueAt in the future is NOT due', () => {
    const surface = makeAgreedSurface({
      lastSyncAt: NOW - 10_000,
      nextSyncDueAt: NOW + 50_000,  // still in the future
    })
    expect(isSurfaceDue(surface, NOW)).toBe(false)
  })

  it('synced surface with now exactly at nextSyncDueAt is due', () => {
    const surface = makeAgreedSurface({
      lastSyncAt: NOW - CADENCE,
      nextSyncDueAt: NOW,
    })
    expect(isSurfaceDue(surface, NOW)).toBe(true)
  })

  it('synced surface with now past nextSyncDueAt is due', () => {
    const surface = makeAgreedSurface({
      lastSyncAt: NOW - CADENCE - 1,
      nextSyncDueAt: NOW - 1,  // overdue
    })
    expect(isSurfaceDue(surface, NOW)).toBe(true)
  })

  it('proposed surface is NOT due (only agreed surfaces trigger)', () => {
    const surface = makeAgreedSurface({ status: 'proposed', lastSyncAt: undefined })
    expect(isSurfaceDue(surface, NOW)).toBe(false)
  })

  it('suspended surface is NOT due', () => {
    const surface = makeAgreedSurface({ status: 'suspended', lastSyncAt: undefined })
    expect(isSurfaceDue(surface, NOW)).toBe(false)
  })

  it('surface without cadenceMs is never due', () => {
    const surface: SurfaceRow = {
      ...makeAgreedSurface(),
      cadenceMs: undefined,
      lastSyncAt: undefined,
      nextSyncDueAt: undefined,
    }
    expect(isSurfaceDue(surface, NOW)).toBe(false)
  })
})

// ─── listDueSurfaces ──────────────────────────────────────────────────────────

describe('listDueSurfaces — filter wrapper', () => {
  it('returns only due (agreed + cadence + overdue/never-synced) surfaces', () => {
    const due = makeAgreedSurface({ id: 'due-1', lastSyncAt: undefined })
    const notDue = makeAgreedSurface({ id: 'not-due', lastSyncAt: NOW - 10_000, nextSyncDueAt: NOW + 50_000 })
    const proposed = makeAgreedSurface({ id: 'proposed-1', status: 'proposed' })
    const noCadence: SurfaceRow = { ...makeAgreedSurface({ id: 'no-cadence' }), cadenceMs: undefined }

    const result = listDueSurfaces([due, notDue, proposed, noCadence], NOW)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('due-1')
  })

  it('returns empty array when no surfaces are due', () => {
    const notDue = makeAgreedSurface({ lastSyncAt: NOW - 1_000, nextSyncDueAt: NOW + 59_000 })
    expect(listDueSurfaces([notDue], NOW)).toHaveLength(0)
  })
})

// ─── markSynced ───────────────────────────────────────────────────────────────

describe('markSynced — stamps lastSyncAt + nextSyncDueAt in the SMV', () => {
  it('stamps lastSyncAt and nextSyncDueAt = now + cadenceMs', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const smv = await StateManagementVault.open(db)

    const surface = makeAgreedSurface({ lastSyncAt: undefined, nextSyncDueAt: undefined })
    await smv.createSurface(surface)

    await markSynced(smv, surface.id, NOW)

    const updated = await smv.getSurface(surface.id)
    expect(updated?.lastSyncAt).toBe(NOW)
    expect(updated?.nextSyncDueAt).toBe(NOW + CADENCE)
  })

  it('isSurfaceDue is false immediately after markSynced, then true once now advances past nextSyncDueAt', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const smv = await StateManagementVault.open(db)

    const surface = makeAgreedSurface({ lastSyncAt: undefined, nextSyncDueAt: undefined })
    await smv.createSurface(surface)

    // Before markSynced: due (never synced)
    expect(isSurfaceDue(surface, NOW)).toBe(true)

    await markSynced(smv, surface.id, NOW)
    const updated = await smv.getSurface(surface.id)

    // Right after markSynced: not due (nextSyncDueAt in the future)
    expect(isSurfaceDue(updated!, NOW)).toBe(false)
    expect(isSurfaceDue(updated!, NOW + CADENCE - 1)).toBe(false)

    // Once now advances past nextSyncDueAt: due again
    expect(isSurfaceDue(updated!, NOW + CADENCE)).toBe(true)
    expect(isSurfaceDue(updated!, NOW + CADENCE + 1)).toBe(true)
  })
})

// ─── SurfaceCadenceScheduler ──────────────────────────────────────────────────

describe('SurfaceCadenceScheduler — thin setInterval driver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('start(id, intervalMs, fn) fires fn on the interval', () => {
    const scheduler = new SurfaceCadenceScheduler()
    const fn = vi.fn()

    scheduler.start('surf-1', 1_000, fn)

    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_000)
    expect(fn).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1_000)
    expect(fn).toHaveBeenCalledTimes(3)

    scheduler.stopAll()
  })

  it('stop(id) cancels the interval for the given surface only', () => {
    const scheduler = new SurfaceCadenceScheduler()
    const fn1 = vi.fn()
    const fn2 = vi.fn()

    scheduler.start('surf-A', 1_000, fn1)
    scheduler.start('surf-B', 1_000, fn2)

    vi.advanceTimersByTime(1_000)
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)

    scheduler.stop('surf-A')

    vi.advanceTimersByTime(1_000)
    expect(fn1).toHaveBeenCalledTimes(1)  // stopped
    expect(fn2).toHaveBeenCalledTimes(2)  // still running

    scheduler.stopAll()
  })

  it('stopAll clears all running intervals', () => {
    const scheduler = new SurfaceCadenceScheduler()
    const fn1 = vi.fn()
    const fn2 = vi.fn()

    scheduler.start('surf-X', 500, fn1)
    scheduler.start('surf-Y', 500, fn2)

    vi.advanceTimersByTime(500)
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)

    scheduler.stopAll()

    vi.advanceTimersByTime(1_000)
    expect(fn1).toHaveBeenCalledTimes(1)  // no more calls
    expect(fn2).toHaveBeenCalledTimes(1)
  })

  it('start on an already-running id replaces the previous interval', () => {
    const scheduler = new SurfaceCadenceScheduler()
    const fn1 = vi.fn()
    const fn2 = vi.fn()

    scheduler.start('surf-1', 1_000, fn1)
    vi.advanceTimersByTime(500)
    // Replace before first fire
    scheduler.start('surf-1', 1_000, fn2)

    vi.advanceTimersByTime(1_000)
    expect(fn1).not.toHaveBeenCalled()  // first interval was cancelled
    expect(fn2).toHaveBeenCalledTimes(1)

    scheduler.stopAll()
  })
})
