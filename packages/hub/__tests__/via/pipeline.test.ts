import { describe, it, expect } from 'vitest'
import type { ViaBinding, ViaReadCtx, ViaWriteCtx } from '../../src/kernel/via/index.js'
import { ViaPipeline, type ViaClause } from '../../src/kernel/via/pipeline.js'

const fixtureBindingA = (): ViaBinding => ({
  brand: 'a',
  posture: { encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: true },
  ingest: (r) => {
    const seq = ((r as Record<string, unknown>).seq as string[]) ?? []
    return { ...r, seq: [...seq, 'a.ingest'] }
  },
  canonicalizeStored: (r) => {
    const seq = ((r as Record<string, unknown>).seq as string[]) ?? []
    return { ...r, seq: [...seq, 'a.canonicalizeStored'] }
  },
  encodeWrite: async (r) => {
    const seq = ((r as Record<string, unknown>).seq as string[]) ?? []
    return {
      ...r,
      seq: [...seq, 'a.encodeWrite'],
    }
  },
  present: async (r) => {
    const seq = ((r as Record<string, unknown>).seq as string[]) ?? []
    return {
      ...r,
      seq: [...seq, 'a.present'],
    }
  },
  buildClause: (field, op) => (field === 'x' ? `a:${op}` : undefined),
  evaluateClause: (actual, op, payload) => payload === `a:${op}` && (actual as string) === 'match',
  decodeResults: (r) => {
    const rec = r as Record<string, unknown>
    const seq = (rec.seq as string[]) ?? []
    return {
      ...rec,
      seq: [...seq, 'a.decodeResults'],
    }
  },
  compareForOrder: (field) => (field === 'x' ? -1 : undefined),
  wrapReducers: (spec) => {
    const s = spec as Record<string, unknown>
    return { ...s, wrapped: [...((s.wrapped as string[]) ?? []), 'a.wrapReducers'] }
  },
})

const fixtureBindingB = (): ViaBinding => ({
  brand: 'b',
  posture: { encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: true },
  ingest: (r) => {
    const seq = ((r as Record<string, unknown>).seq as string[]) ?? []
    return { ...r, seq: [...seq, 'b.ingest'] }
  },
  canonicalizeStored: (r) => {
    const seq = ((r as Record<string, unknown>).seq as string[]) ?? []
    return { ...r, seq: [...seq, 'b.canonicalizeStored'] }
  },
  encodeWrite: async (r) => {
    const seq = ((r as Record<string, unknown>).seq as string[]) ?? []
    return {
      ...r,
      seq: [...seq, 'b.encodeWrite'],
    }
  },
  present: async (r) => {
    const seq = ((r as Record<string, unknown>).seq as string[]) ?? []
    return {
      ...r,
      seq: [...seq, 'b.present'],
    }
  },
  buildClause: (field, op) => (field === 'y' ? `b:${op}` : undefined),
  evaluateClause: (actual, op, payload) => payload === `b:${op}` && (actual as string) === 'match',
  decodeResults: (r) => {
    const rec = r as Record<string, unknown>
    const seq = (rec.seq as string[]) ?? []
    return {
      ...rec,
      seq: [...seq, 'b.decodeResults'],
    }
  },
  compareForOrder: (field) => (field === 'y' ? 1 : undefined),
  wrapReducers: (spec) => {
    const s = spec as Record<string, unknown>
    return { ...s, wrapped: [...((s.wrapped as string[]) ?? []), 'b.wrapReducers'] }
  },
})

describe('ViaPipeline', () => {
  it('build([]) returns undefined', () => {
    const p = ViaPipeline.build([])
    expect(p).toBeUndefined()
  })

  it('build with bindings returns ViaPipeline', () => {
    const p = ViaPipeline.build([fixtureBindingA()])
    expect(p).toBeDefined()
    expect(p?.bindings).toHaveLength(1)
  })

  it('ingest folds in order (a before b)', () => {
    const p = ViaPipeline.build([fixtureBindingA(), fixtureBindingB()])!
    const result = p.ingest({ seq: [] })
    expect(result.seq).toEqual(['a.ingest', 'b.ingest'])
  })

  it('canonicalizeStored folds in order', () => {
    const p = ViaPipeline.build([fixtureBindingA(), fixtureBindingB()])!
    const result = p.canonicalizeStored({ seq: [] })
    expect(result.seq).toEqual(['a.canonicalizeStored', 'b.canonicalizeStored'])
  })

  it('encodeWrite folds in order with async', async () => {
    const p = ViaPipeline.build([fixtureBindingA(), fixtureBindingB()])!
    const ctx: ViaWriteCtx = {
      id: 'test-id',
      vault: 'test-vault',
      prior: async () => null,
      emit: () => {},
    }
    const result = await p.encodeWrite({ seq: [] }, ctx)
    expect(result.seq).toEqual(['a.encodeWrite', 'b.encodeWrite'])
  })

  it('present folds in order with async', async () => {
    const p = ViaPipeline.build([fixtureBindingA(), fixtureBindingB()])!
    const ctx: ViaReadCtx = { layer: 'test' }
    const result = await p.present({ seq: [] }, ctx)
    expect(result.seq).toEqual(['a.present', 'b.present'])
  })

  it('buildClause first-covering-wins', () => {
    const p = ViaPipeline.build([fixtureBindingA(), fixtureBindingB()])!
    const clause = p.buildClause('x', 'eq', 'value')
    expect(clause).toEqual({ brand: 'a', payload: 'a:eq' })
  })

  it('buildClause falls through to second binding when first does not cover', () => {
    const p = ViaPipeline.build([fixtureBindingA(), fixtureBindingB()])!
    const clause = p.buildClause('y', 'eq', 'value')
    expect(clause).toEqual({ brand: 'b', payload: 'b:eq' })
  })

  it('buildClause returns undefined when no binding covers', () => {
    const p = ViaPipeline.build([fixtureBindingA(), fixtureBindingB()])!
    const clause = p.buildClause('z', 'eq', 'value')
    expect(clause).toBeUndefined()
  })

  it('evaluateClause routes by brand', () => {
    const p = ViaPipeline.build([fixtureBindingA(), fixtureBindingB()])!
    const clauseA: ViaClause = { brand: 'a', payload: 'a:eq' }
    const clauseB: ViaClause = { brand: 'b', payload: 'b:eq' }

    expect(p.evaluateClause(clauseA, 'match', 'eq')).toBe(true)
    expect(p.evaluateClause(clauseB, 'match', 'eq')).toBe(true)
  })

  it('evaluateClause returns false for missing binding', () => {
    const p = ViaPipeline.build([fixtureBindingA()])!
    const clauseB: ViaClause = { brand: 'b', payload: 'b:eq' }
    expect(p.evaluateClause(clauseB, 'match', 'eq')).toBe(false)
  })

  it('decodeResults folds in order', () => {
    const p = ViaPipeline.build([fixtureBindingA(), fixtureBindingB()])!
    const result = p.decodeResults({ seq: [] }) as Record<string, unknown>
    expect(result.seq).toEqual(['a.decodeResults', 'b.decodeResults'])
  })

  it('compareForOrder first-covering-wins', () => {
    const p = ViaPipeline.build([fixtureBindingA(), fixtureBindingB()])!
    // 'x' is covered by binding a
    expect(p.compareForOrder('x', 'a', 'b')).toBe(-1)
    // 'y' is covered by binding b
    expect(p.compareForOrder('y', 'a', 'b')).toBe(1)
    // 'z' is not covered
    expect(p.compareForOrder('z', 'a', 'b')).toBeUndefined()
  })

  it('wrapReducers folds in order', () => {
    const p = ViaPipeline.build([fixtureBindingA(), fixtureBindingB()])!
    const spec = { wrapped: [] as string[] }
    const result = p.wrapReducers(spec) as Record<string, unknown>
    expect(result.wrapped).toEqual(['a.wrapReducers', 'b.wrapReducers'])
  })

  it('hasResultDecode true when any binding has decodeResults', () => {
    const bindingWithoutDecode: ViaBinding = {
      brand: 'c',
      posture: { encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: true },
    }
    const pWithDecode = ViaPipeline.build([fixtureBindingA(), bindingWithoutDecode])!
    expect(pWithDecode.hasResultDecode).toBe(true)

    const pWithoutDecode = ViaPipeline.build([bindingWithoutDecode])!
    expect(pWithoutDecode.hasResultDecode).toBe(false)
  })

  it('handles empty binding hooks gracefully', () => {
    const minimalBinding: ViaBinding = {
      brand: 'minimal',
      posture: { encryptedAtRest: 'envelope', queryable: 'none', exportable: false, forgettable: false },
    }
    const p = ViaPipeline.build([minimalBinding])!
    const record = { foo: 'bar' }

    // Should pass through unchanged
    expect(p.ingest(record)).toEqual(record)
    expect(p.canonicalizeStored(record)).toEqual(record)
    expect(p.decodeResults(record)).toEqual(record)
    expect(p.compareForOrder('x', 'a', 'b')).toBeUndefined()
  })
})
