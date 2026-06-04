import { describe, it, expect } from 'vitest'
import { createInspector } from '../src/index.js'
import type { InspectorNoydb, InspectorWriteConflict } from '../src/types.js'

function fakeNoydb(): InspectorNoydb & { emitConflict: (c: InspectorWriteConflict) => void } {
  const listeners = new Set<(c: InspectorWriteConflict) => void>()
  return {
    onAfterWrite: () => () => {},
    writeQueue: { pending: false, depth: 0 },
    listVaults: async () => [],
    onWriteConflict(fn: (c: InspectorWriteConflict) => void) { listeners.add(fn); return () => listeners.delete(fn) },
    emitConflict(c) { for (const l of listeners) l(c) },
  } as unknown as InspectorNoydb & { emitConflict: (c: InspectorWriteConflict) => void }
}

const sampleConflict: InspectorWriteConflict = {
  vault: 'v', collection: 'invoices', docId: 'inv1',
  local: { n: 1 }, remote: { n: 2 }, base: { n: 0 },
  localVersion: 1, remoteVersion: 1, baseVersion: 0,
}

describe('inspector.subscribeConflicts', () => {
  it('fans out conflicts and unsubscribes', () => {
    const db = fakeNoydb()
    const inspector = createInspector(db)
    const seen: InspectorWriteConflict[] = []
    const off = inspector.subscribeConflicts((c) => seen.push(c))
    db.emitConflict(sampleConflict)
    expect(seen).toEqual([sampleConflict])
    off()
    db.emitConflict(sampleConflict)
    expect(seen).toHaveLength(1)
  })
})
