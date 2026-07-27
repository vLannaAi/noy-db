import { describe, it, expect } from 'vitest'
import type { DerivedFromMeta, DerivationSpec, OutputSpec } from '../../src/with-formula/derivations/types.js'

describe('Derivation types', () => {
  it('DerivedFromMeta has the documented fields', () => {
    const meta: DerivedFromMeta = {
      source: 'pdfs',
      sourceId: 'abc',
      sourceVersion: 3,
      derivedAt: '2026-05-18T00:00:00.000Z',
      strategyHash: 'sha256-x',
    }
    expect(meta.source).toBe('pdfs')
    expect(meta.strategyHash).toBe('sha256-x')
  })

  it('DerivationSpec carries source, outputs map, derive, lifecycle', () => {
    const strategy: DerivationSpec<{ body: string }, { meta: { len: number } }> = {
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    }
    expect(strategy.source).toBe('pdfs')
    expect(strategy.outputs.meta.collection).toBe('pdf-meta')
  })

  it('OutputSpec has shape and collection', () => {
    const spec: OutputSpec = { shape: 'record', collection: 'pdf-meta' }
    expect(spec.shape).toBe('record')
  })
})
