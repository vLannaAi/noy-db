/**
 * Concurrent `openVault(name)` calls must converge on ONE Vault instance
 * (#564). Before the single-flight memo, two callers racing past the
 * `vaultCache` miss each constructed a Vault; their Collections then minted
 * independent DEKs for the same store slice, so a record written through one
 * failed decryption through the other with a spurious `TamperedError` — the
 * recurring in-pinia CI flake (unhandled rejection from a background
 * federation-re-bind `refresh()` racing an `add()`).
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { inlineMemory } from './classified/harness.js'

describe('openVault — single-flight per name', () => {
  it('concurrent opens of the same name return the same Vault instance', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'u', secret: 'open-race-pw' })
    const [v1, v2, v3] = await Promise.all([
      db.openVault('same'),
      db.openVault('same'),
      db.openVault('same'),
    ])
    expect(v1).toBe(v2)
    expect(v2).toBe(v3)
  }, 60_000)

  it('a write through one racing opener is readable through the other', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'u', secret: 'open-race-pw-2' })
    const [va, vb] = await Promise.all([db.openVault('shared'), db.openVault('shared')])
    type Row = { id: string; n: number }
    const ca = va.collection<Row>('rows')
    const cb = vb.collection<Row>('rows')
    await ca.put('a', { id: 'a', n: 1 })
    // Pre-fix this threw TamperedError: cb held a different DEK for 'rows'.
    const listed = await cb.list()
    expect(listed.map((r) => r.id)).toEqual(['a'])
  }, 60_000)

  it('different names still open independently', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'u', secret: 'open-race-pw-3' })
    const [v1, v2] = await Promise.all([db.openVault('one'), db.openVault('two')])
    expect(v1).not.toBe(v2)
    expect(v1.name).toBe('one')
    expect(v2.name).toBe('two')
  }, 60_000)
})
