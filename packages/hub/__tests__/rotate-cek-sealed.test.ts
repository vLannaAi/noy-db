/**
 * Regression: `vault.rotateRecordCek` must preserve a record's sealed
 * (`sensitive`) fields. Before the fix, the rotated envelope carried `_tier`
 * and `_det` forward but NOT `_sealed`, silently losing the sealed values on
 * every CEK rotation of a `sensitive` collection (a data-loss bug; groundwork
 * for record-scoped sealing #306). Sealed fields are keyed off the collection
 * DEK, not the per-record CEK, so a CEK rotation does not invalidate them —
 * they just need to be carried forward.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/store/memory-store.js'
import { withSealedRecord } from '../src/with-audit/sealed-record/index.js'

interface Person { id: string; name: string; ssn: string }

describe('rotateRecordCek preserves sealed fields (#306 data-loss fix)', () => {
  it('a sealed field survives a CEK rotation', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'alice', secret: 'rotate-sealed-passphrase-2026-pilot', sealedRecordStrategy: withSealedRecord() })
    const vault = await db.openVault('v')
    // 2nd generic types `ssn` as a Sealed<string> handle on reads.
    const people = vault.collection<Person, 'ssn'>('people', { perRecordKeys: true, sensitive: ['ssn'] })
    await people.put('p1', { id: 'p1', name: 'Ada', ssn: '123-45-6789' })

    // Sanity: the sealed field reveals before rotation.
    const before = await people.get('p1')
    expect(await before!.ssn.reveal()).toBe('123-45-6789')

    await vault.rotateRecordCek('people', 'p1')

    const after = await people.get('p1')
    expect(after).not.toBeNull()
    expect(after!.name).toBe('Ada')                       // non-sealed body survives
    // The fix: _sealed was carried forward, so reveal() still decrypts.
    // Pre-fix this threw (the `_sealed` slot was gone from the rotated envelope).
    expect(await after!.ssn.reveal()).toBe('123-45-6789')
  })
})
