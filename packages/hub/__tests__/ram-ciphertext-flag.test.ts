import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/index.js'

describe('ramCiphertext flag', () => {
  it('collection without ramCiphertext option works normally (default false)', async () => {
    const db = await createNoydb({ user: 'test-user', secret: 'correct-horse-battery-staple' })
    const vault = await db.openVault('v1')
    const items = vault.collection<{ id: string; n: number }>('items')
    await items.put('1', { id: '1', n: 99 })
    expect((await items.get('1'))?.n).toBe(99)
    expect(items._ramCiphertext).toBe(false)
  })

  it('collection with ramCiphertext: true is accepted and exposed via getter', async () => {
    const db = await createNoydb({ user: 'test-user', secret: 'correct-horse-battery-staple' })
    const vault = await db.openVault('v1')
    const items = vault.collection<{ id: string; n: number }>('items', { ramCiphertext: true })
    await items.put('1', { id: '1', n: 7 })
    expect((await items.get('1'))?.n).toBe(7)
    expect(items._ramCiphertext).toBe(true)
  })
})
