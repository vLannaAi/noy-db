import { describe, it, expect } from 'vitest'
import { classified, luhnCheck } from '../../src/with-shape/classified/index.js'
import { resolveClassifiedFields } from '../../src/with-shape/classified/resolve.js'

describe('classified presets', () => {
  it('luhnCheck accepts a valid PAN and rejects a corrupted one', () => {
    expect(luhnCheck('4242424242424242')).toBe(true)
    expect(luhnCheck('4242424242424241')).toBe(false)
  })

  it('creditCard maps roles to fields with differential policy', () => {
    const g = classified.creditCard({ pan: 'cardNumber', expiry: 'cardExpiry', cvc: 'cardCvc' })
    const r = resolveClassifiedFields('c', { card: g })
    expect(r.byField.cardNumber!.storage).toBe('recoverable')
    expect(r.byField.cardNumber!.sensitivity).toBe('secret')
    expect(r.byField.cardCvc!.storage).toBe('never')
    expect(r.byField.cardExpiry!.storage).toBe('recoverable')
    expect(r.riderComputed['cardNumber_last4']!({ cardNumber: '4242 4242 4242 4242' })).toBe('4242')
    expect(r.riderComputed['cardNumber_bin']!({ cardNumber: '4242 4242 4242 4242' })).toBe('424242')
  })

  it('pan validator refuses a Luhn-invalid number; cvc validator wants 3-4 digits', () => {
    const g = classified.creditCard({ pan: 'pan', cvc: 'cvc' })
    const r = resolveClassifiedFields('c', { card: g })
    expect(r.byField.pan!.validate!('4242424242424241')).toMatch(/Luhn/)
    expect(r.byField.pan!.validate!('4242424242424242')).toBeNull()
    expect(r.byField.cvc!.validate!('12')).toMatch(/3-4 digits/)
    expect(r.byField.cvc!.validate!('123')).toBeNull()
  })

  it('birthDate: ISO validation, yob rider, mask pattern references yob', () => {
    const s = classified.birthDate()
    expect(s.validate!('1990-04-01')).toBeNull()
    expect(s.validate!('01/04/1990')).toMatch(/ISO/)
    expect(s.validate!('1990-13-45')).toMatch(/calendar/)
    expect(s.validate!('1990-02-30')).toMatch(/calendar/)
    expect(s.riders!.yob!('1990-04-01')).toBe('1990')
    expect(s.list).toEqual({ kind: 'mask', pattern: '${yob}-••-••' })
  })

  it('email/phone: pii, domain/last2 riders', () => {
    expect(classified.email().riders!.domain!('a@b.co')).toBe('b.co')
    expect(classified.phone().riders!.last2!('+66 81 234 5678')).toBe('78')
  })
})
