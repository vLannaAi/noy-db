import { describe, it, expect } from 'vitest'
import { createInspector, type InspectableContainer } from '../src/index.js'
import type { Noydb } from '@noy-db/hub'

describe('InspectableContainer contract', () => {
  it('a real Noydb is assignable to InspectableContainer (compile-time proof)', () => {
    const asContainer = (n: Noydb): InspectableContainer => n
    expect(typeof asContainer).toBe('function')
  })

  it('createInspector accepts any structural InspectableContainer', () => {
    const container: InspectableContainer = {
      async listAccessibleVaults() {
        return []
      },
      async openVault() {
        throw new Error('not exercised by this test')
      },
      onAfterWrite() {
        return () => {}
      },
      onWriteConflict() {
        return () => {}
      },
      get writeQueue() {
        return { pending: false, depth: 0, onChange: () => () => {}, onFlush: async () => {} }
      },
    }
    const inspector = createInspector(container)
    expect(typeof inspector.listVaults).toBe('function')
    expect(inspector.pendingWrites()).toEqual({ pending: false, depth: 0 })
  })
})
