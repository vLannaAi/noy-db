import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '../src/index.js'

// Regression for #321 — the factory documented `casAtomic: true` in its
// JSDoc but never populated `capabilities` on the returned store, so
// `vault.sequence().next()` (which gates on `capabilities.casAtomic`) threw
// SequenceOfflineError even though memory is synchronously atomic.
describe('memory() capabilities (#321)', () => {
  it('advertises casAtomic:true with a valid auth descriptor', () => {
    const caps = memory().capabilities
    expect(caps).toBeDefined()
    expect(caps?.casAtomic).toBe(true)
    expect(caps?.auth.kind).toBe('none')
    expect(caps?.auth.required).toBe(false)
  })

  it('vault.sequence().next() works end-to-end against the real adapter (no SequenceOfflineError)', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const v = await db.openVault('v')
    const seq = v.sequence('invoice-2026')
    expect(await seq.next()).toBe(1)
    expect(await seq.next()).toBe(2)
  })
})
