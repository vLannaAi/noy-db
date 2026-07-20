import { describe, it, expect } from 'vitest'
import { installViaBinder, isViaInstalled, viaBinder, type ViaBinding } from '../../src/kernel/via/index.js'
import { NoydbError } from '../../src/kernel/errors.js'

describe('via port', () => {
  it('(a) isViaInstalled and installViaBinder work together', () => {
    // Start with uninstalled
    expect(isViaInstalled('test-feature-a')).toBe(false)

    // Install a binder
    const testBinder = () => ({
      brand: 'test-feature-a',
      posture: {
        encryptedAtRest: 'envelope' as const,
        queryable: 'none' as const,
        exportable: true,
        forgettable: true,
      },
    })

    installViaBinder('test-feature-a', testBinder)

    // Now it should be installed
    expect(isViaInstalled('test-feature-a')).toBe(true)
  })

  it('(b) viaBinder throws NoydbError with VIA_NOT_LINKED code when missing', () => {
    expect(() => viaBinder('missing-feature')).toThrow(NoydbError)
    try {
      viaBinder('missing-feature')
    } catch (err) {
      expect(err).toBeInstanceOf(NoydbError)
      expect((err as NoydbError).code).toBe('VIA_NOT_LINKED')
    }
  })

  it('(c) installViaBinder is first-wins (second install ignored)', () => {
    const brand = 'test-feature-first-wins'
    const firstBinder = () => ({
      brand,
      posture: {
        encryptedAtRest: 'envelope' as const,
        queryable: 'none' as const,
        exportable: true,
        forgettable: true,
      },
    })
    const secondBinder = () => ({
      brand,
      posture: {
        encryptedAtRest: 'sealed' as const,
        queryable: 'full' as const,
        exportable: false,
        forgettable: false,
      },
    })

    installViaBinder(brand, firstBinder)
    installViaBinder(brand, secondBinder)

    // Should return the first binder
    const retrieved = viaBinder(brand)
    expect(retrieved).toBe(firstBinder)
  })

  it('(d) ViaBinding fixture typechecks with only brand + posture', () => {
    const binding: ViaBinding = {
      brand: 'test-feature-minimal',
      posture: {
        encryptedAtRest: 'envelope',
        queryable: 'none',
        exportable: true,
        forgettable: true,
      },
    }

    expect(binding.brand).toBe('test-feature-minimal')
    expect(binding.posture.encryptedAtRest).toBe('envelope')
    // All other fields are optional, so they should be undefined or absent
    expect(binding.ingest).toBeUndefined()
    expect(binding.canonicalizeStored).toBeUndefined()
    expect(binding.encodeWrite).toBeUndefined()
    expect(binding.present).toBeUndefined()
    expect(binding.buildClause).toBeUndefined()
    expect(binding.evaluateClause).toBeUndefined()
    expect(binding.decodeResults).toBeUndefined()
    expect(binding.compareForOrder).toBeUndefined()
    expect(binding.wrapReducers).toBeUndefined()
    expect(binding.describeFragment).toBeUndefined()
  })
})
