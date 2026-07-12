import { describe, it, expect } from 'vitest'
import { ViaGraph, DEFAULT_POSTURE, foldWildcardSecurity } from '../../src/kernel/via-graph.js'
import type { ViaPosture } from '../../src/kernel/via.js'

// Real postures from the shipped bindings (shape/via-classified/binding.ts:213,
// shape/via-blob/binding.ts:107) — used as realistic fixtures, not re-declared via
// any shape/** import (the graph itself never imports shape/**).
const CLASSIFIED: ViaPosture = { encryptedAtRest: 'sealed', queryable: 'det-exact', exportable: false, forgettable: true }
const BLOB: ViaPosture = { encryptedAtRest: 'envelope', queryable: 'none', exportable: true, forgettable: true }

describe('foldWildcardSecurity — the security-axes-only fold (#642)', () => {
  it('folds encryptedAtRest/exportable/forgettable but leaves queryable at base', () => {
    expect(foldWildcardSecurity(DEFAULT_POSTURE, CLASSIFIED)).toEqual({
      encryptedAtRest: 'sealed',
      queryable: 'full', // base's queryable, UNCHANGED — CLASSIFIED's 'det-exact' does not propagate
      exportable: false,
      forgettable: true,
    })
  })

  it('queryable always tracks base, never the contributor, regardless of contributor value', () => {
    const base: ViaPosture = { ...DEFAULT_POSTURE, queryable: 'ordered' }
    expect(foldWildcardSecurity(base, CLASSIFIED).queryable).toBe('ordered')
    expect(foldWildcardSecurity(base, BLOB).queryable).toBe('ordered')
  })
})

describe("ViaGraph — kind- & axis-scoped '*' posture fold (#642)", () => {
  it("a derivation '*' output inherits its source collection's registered-field fold (sealed, non-exportable, forgettable — queryable stays full)", () => {
    const g = new ViaGraph()
    g.registerField('src', 'ssn', CLASSIFIED)
    g.registerField('src', 'plain', DEFAULT_POSTURE)
    g.registerDerived({ collection: 'out', field: '*' }, [{ collection: 'src', field: '*' }], 'derivation', 'record')

    expect(g.effectivePosture({ collection: 'out', field: '*' })).toEqual({
      encryptedAtRest: 'sealed',
      queryable: 'full',
      exportable: false,
      forgettable: true,
    })
  })

  it('TRAP 2 — a blob field (queryable: none) in the source collection does NOT make a derivation output unqueryable; only forgettable ORs in', () => {
    const g = new ViaGraph()
    g.registerField('src2', 'doc', BLOB)
    g.registerDerived({ collection: 'out2', field: '*' }, [{ collection: 'src2', field: '*' }], 'derivation', 'record')

    const posture = g.effectivePosture({ collection: 'out2', field: '*' })
    expect(posture?.queryable).toBe('full') // NOT 'none' — blob does not clamp derived-output queryability
    expect(posture?.forgettable).toBe(true) // BLOB's forgettable:true still ORs in
  })

  it("TRAP 1 — a 'ref' edge's '*' source stays DEFAULT_POSTURE (identity) even though the backing collection has a classified field — lookup-referencing fields must not seal", () => {
    const g = new ViaGraph()
    g.registerField('countries', 'iso2', CLASSIFIED)
    g.registerDerived(
      { collection: 'orders', field: 'country' },
      [{ collection: 'countries', field: '*' }],
      'ref',
      'record',
    )

    expect(g.effectivePosture({ collection: 'orders', field: 'country' })).toEqual(DEFAULT_POSTURE)
  })

  it('a rollup edge (real-field target) DOES fold sealed from its "*" source collection — kind-scoping only excludes ref, not rollup', () => {
    const g = new ViaGraph()
    g.registerField('src3', 'ssn', CLASSIFIED)
    g.registerDerived(
      { collection: 'parent', field: 'total' },
      [{ collection: 'src3', field: '*' }],
      'rollup',
      'aggregate',
    )

    const posture = g.effectivePosture({ collection: 'parent', field: 'total' })
    expect(posture?.encryptedAtRest).toBe('sealed')
  })

  it("an 'mv' edge folds sealed identically to derivation/rollup — kind-scoping includes mv", () => {
    const g = new ViaGraph()
    g.registerField('src4', 'ssn', CLASSIFIED)
    g.registerDerived({ collection: 'out4', field: '*' }, [{ collection: 'src4', field: '*' }], 'mv', 'record')

    const posture = g.effectivePosture({ collection: 'out4', field: '*' })
    expect(posture?.encryptedAtRest).toBe('sealed')
  })

  it("an 'overlay' edge folds sealed identically — kind-scoping includes overlay", () => {
    const g = new ViaGraph()
    g.registerField('src5', 'ssn', CLASSIFIED)
    g.registerDerived({ collection: 'out5', field: '*' }, [{ collection: 'src5', field: '*' }], 'overlay', 'record')

    const posture = g.effectivePosture({ collection: 'out5', field: '*' })
    expect(posture?.encryptedAtRest).toBe('sealed')
  })

  it('ordering is free: registering the classified source field AFTER the derivation edge still folds sealed (cache cleared on the late registerField)', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'lateOut', field: '*' }, [{ collection: 'lateSrc', field: '*' }], 'derivation', 'record')
    // Read once before the classified field exists — establishes a cached (non-sealed) result.
    expect(g.effectivePosture({ collection: 'lateOut', field: '*' })).toEqual(DEFAULT_POSTURE)
    // Late registration — must invalidate both _effectiveCache and _wildcardCache.
    g.registerField('lateSrc', 'ssn', CLASSIFIED)
    expect(g.effectivePosture({ collection: 'lateOut', field: '*' })?.encryptedAtRest).toBe('sealed')
  })
})
