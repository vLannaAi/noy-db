import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/index.js'

// The point of this test: NO `store` is passed.
// Minimal non-store options copied from packages/hub/__tests__/integration.test.ts.
describe('createNoydb without a store', () => {
  it('defaults to the built-in memoryStore and round-trips a record', async () => {
    const db = await createNoydb({ user: 'test-user', secret: 'correct-horse-battery-staple' })
    const vault = await db.openVault('v1')
    const items = vault.collection<{ id: string; n: number }>('items')
    await items.put('1', { id: '1', n: 42 })
    expect((await items.get('1'))?.n).toBe(42)
  })
})
