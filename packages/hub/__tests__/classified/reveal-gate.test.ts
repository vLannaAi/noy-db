import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { classified, withClassified } from '../../src/shape/via-classified/index.js'
import { ClassifiedNotEnabledError } from '../../src/kernel/errors.js'
import { inlineMemory } from './harness.js'

describe('withClassified gate + reveal', () => {
  it('reveal throws ClassifiedNotEnabledError without the strategy', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-rv-1' })
    const v = await db.openVault('v1')
    const c = v.collection('cards', { classifiedFields: { card: classified.creditCard({ pan: 'pan' }) } })
    await c.put('r1', { pan: '4242424242424242' })
    await expect(c.reveal('r1', 'pan')).rejects.toBeInstanceOf(ClassifiedNotEnabledError)
  })

  it('reveal returns the plaintext with withClassified(), and refuses unknown/never fields', async () => {
    const db = await createNoydb({
      store: inlineMemory(), user: 'a', secret: 'pw-rv-2',
      classifiedStrategy: withClassified(),
    })
    const v = await db.openVault('v2')
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan', cvc: 'cvc' }) },
    })
    await c.put('r1', { pan: '4242424242424242' })
    expect(await c.reveal('r1', 'pan')).toBe('4242424242424242')
    await expect(c.reveal('r1', 'cvc')).rejects.toThrow(/never/)     // nothing stored to reveal
    await expect(c.reveal('r1', 'nope')).rejects.toThrow(/not classified/)
  })
})
