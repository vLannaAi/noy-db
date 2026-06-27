import { describe, it, expect } from 'vitest'
import { createInspector } from '../src/index.js'
import type { InspectorNoydb, InspectorMeter } from '../src/types.js'
import type { MeterSnapshot } from '@noy-db/to-meter'

const stubNoydb = {
  onAfterWrite: () => () => {}, writeQueue: { pending: false, depth: 0 },
  listVaults: async () => [], onWriteConflict: () => () => {},
} as unknown as InspectorNoydb

const snap = { status: 'ok', totalCalls: 5, byMethod: {}, casConflicts: 0, windowMs: 1000, collectedAt: 'x' } as unknown as MeterSnapshot

describe('inspector.meterSnapshot', () => {
  it('returns null when no meter is supplied', () => {
    expect(createInspector(stubNoydb).meterSnapshot()).toBeNull()
  })
  it('returns the meter snapshot when a handle is supplied', () => {
    const meter: InspectorMeter = { snapshot: () => snap }
    expect(createInspector(stubNoydb, { meter }).meterSnapshot()).toBe(snap)
  })
})
