import { describe, it, expect } from 'vitest'
import type { LedgerEntry } from '../../src/history/ledger/entry.js'

describe('LedgerEntry amendment op', () => {
  it('accepts an amendment entry shape', () => {
    const entry: LedgerEntry = {
      index: 5,
      prevHash: 'abc',
      op: 'amendment',
      collection: '',
      id: '',
      version: 0,
      ts: '2026-05-18T00:00:00.000Z',
      actor: 'alice',
      payloadHash: 'hash',
      amendment: {
        reason: 'correct split',
        role: 'admin',
        changes: [
          { collection: 'lines', id: 'l1', vBefore: 2, vAfter: 3 },
          { collection: 'lines', id: 'l2', vBefore: 1, vAfter: 2 },
        ],
        invariantsPassed: ['lines'],
      },
    }
    expect(entry.op).toBe('amendment')
    expect(entry.amendment?.changes).toHaveLength(2)
  })
})
