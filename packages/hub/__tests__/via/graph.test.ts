import { describe, it, expect } from 'vitest'
import { DerivationCycleError, MaterializedViewCycleError } from '../../src/kernel/errors.js'
import { ViaGraph, DEFAULT_POSTURE, foldPosture } from '../../src/kernel/via/graph.js'
import type { ViaPosture } from '../../src/kernel/via/index.js'

// Real postures from the shipped bindings (via/classified/binding.ts:213,
// via/money/binding.ts:23) — used as realistic fixtures, not re-declared
// via any via/** import (the graph itself never imports via/**).
const CLASSIFIED: ViaPosture = { encryptedAtRest: 'sealed', queryable: 'det-exact', exportable: false, forgettable: true }
const MONEY: ViaPosture = { encryptedAtRest: 'envelope', queryable: 'ordered', exportable: true, forgettable: true }

describe('foldPosture — the pure taint algebra', () => {
  it('folds classified + money to the strictest per-axis result (§2)', () => {
    expect(foldPosture(CLASSIFIED, MONEY)).toEqual({
      encryptedAtRest: 'sealed',
      queryable: 'det-exact',
      exportable: false,
      forgettable: true,
    })
  })

  it('is commutative (order of fold does not matter)', () => {
    expect(foldPosture(MONEY, CLASSIFIED)).toEqual(foldPosture(CLASSIFIED, MONEY))
  })

  it('sealed wins over envelope on encryptedAtRest', () => {
    const envelope: ViaPosture = { ...DEFAULT_POSTURE, encryptedAtRest: 'envelope' }
    const sealed: ViaPosture = { ...DEFAULT_POSTURE, encryptedAtRest: 'sealed' }
    expect(foldPosture(envelope, sealed).encryptedAtRest).toBe('sealed')
    expect(foldPosture(sealed, envelope).encryptedAtRest).toBe('sealed')
  })

  it('queryable takes the least-capable rung on the none < det-exact < ordered < full ladder', () => {
    const rungs: ViaPosture['queryable'][] = ['none', 'det-exact', 'ordered', 'full']
    for (let i = 0; i < rungs.length; i++) {
      for (let j = 0; j < rungs.length; j++) {
        const a: ViaPosture = { ...DEFAULT_POSTURE, queryable: rungs[i]! }
        const b: ViaPosture = { ...DEFAULT_POSTURE, queryable: rungs[j]! }
        expect(foldPosture(a, b).queryable).toBe(rungs[Math.min(i, j)])
      }
    }
  })

  it('exportable is a logical AND', () => {
    expect(foldPosture({ ...DEFAULT_POSTURE, exportable: true }, { ...DEFAULT_POSTURE, exportable: true }).exportable).toBe(true)
    expect(foldPosture({ ...DEFAULT_POSTURE, exportable: true }, { ...DEFAULT_POSTURE, exportable: false }).exportable).toBe(false)
    expect(foldPosture({ ...DEFAULT_POSTURE, exportable: false }, { ...DEFAULT_POSTURE, exportable: false }).exportable).toBe(false)
  })

  it('forgettable is a logical OR — a forgettable source forces the derived field forgettable', () => {
    expect(foldPosture({ ...DEFAULT_POSTURE, forgettable: false }, { ...DEFAULT_POSTURE, forgettable: false }).forgettable).toBe(false)
    expect(foldPosture({ ...DEFAULT_POSTURE, forgettable: true }, { ...DEFAULT_POSTURE, forgettable: false }).forgettable).toBe(true)
    expect(foldPosture({ ...DEFAULT_POSTURE, forgettable: false }, { ...DEFAULT_POSTURE, forgettable: true }).forgettable).toBe(true)
  })

  it('folding DEFAULT_POSTURE with itself is a no-op (max-permissive baseline)', () => {
    expect(foldPosture(DEFAULT_POSTURE, DEFAULT_POSTURE)).toEqual(DEFAULT_POSTURE)
  })
})

describe('ViaGraph — registration + effective posture', () => {
  it('effectivePosture is undefined for a field with no in-edges (not derived)', () => {
    const g = new ViaGraph()
    g.registerField('customers', 'name', DEFAULT_POSTURE)
    expect(g.effectivePosture({ collection: 'customers', field: 'name' })).toBeUndefined()
    // Never-registered fields are equally "not derived".
    expect(g.effectivePosture({ collection: 'customers', field: 'unknown' })).toBeUndefined()
  })

  it('a later registerField declaration for the same node is a no-op — first wins (idempotent)', () => {
    const g = new ViaGraph()
    g.registerField('customers', 'ssn', CLASSIFIED)
    g.registerField('customers', 'ssn', MONEY)
    g.registerDerived({ collection: 'customers', field: 'ssnCopy' }, [{ collection: 'customers', field: 'ssn' }], 'computed', 'record')
    expect(g.effectivePosture({ collection: 'customers', field: 'ssnCopy' })).toEqual(
      foldPosture(DEFAULT_POSTURE, CLASSIFIED),
    )
  })

  it('a derived target inherits its source classified field\'s sealed/non-export/non-query posture (#636 fixture)', () => {
    const g = new ViaGraph()
    g.registerField('customers', 'ssn', CLASSIFIED)
    g.registerDerived(
      { collection: 'customers', field: 'total' },
      [{ collection: 'customers', field: 'ssn' }],
      'computed',
      'record',
    )
    expect(g.effectivePosture({ collection: 'customers', field: 'total' })).toEqual(
      foldPosture(DEFAULT_POSTURE, CLASSIFIED),
    )
  })

  it('a plain (never registerField-declared) source folds in as DEFAULT_POSTURE', () => {
    const g = new ViaGraph()
    g.registerDerived(
      { collection: 'customers', field: 'derivedPlain' },
      [{ collection: 'customers', field: 'unregisteredPlain' }],
      'computed',
      'record',
    )
    expect(g.effectivePosture({ collection: 'customers', field: 'derivedPlain' })).toEqual(DEFAULT_POSTURE)
  })

  it('folds across MULTIPLE sources (strictest wins per axis)', () => {
    const g = new ViaGraph()
    g.registerField('customers', 'ssn', CLASSIFIED)
    g.registerField('customers', 'price', MONEY)
    g.registerDerived(
      { collection: 'customers', field: 'combo' },
      [{ collection: 'customers', field: 'ssn' }, { collection: 'customers', field: 'price' }],
      'computed',
      'record',
    )
    expect(g.effectivePosture({ collection: 'customers', field: 'combo' })).toEqual(
      foldPosture(foldPosture(DEFAULT_POSTURE, CLASSIFIED), MONEY),
    )
  })

  it('transitive taint: a → b → c propagates sealed all the way to c', () => {
    const g = new ViaGraph()
    g.registerField('c', 'a', CLASSIFIED)
    g.registerDerived({ collection: 'c', field: 'b' }, [{ collection: 'c', field: 'a' }], 'computed', 'record')
    g.registerDerived({ collection: 'c', field: 'c' }, [{ collection: 'c', field: 'b' }], 'computed', 'record')
    const effB = g.effectivePosture({ collection: 'c', field: 'b' })
    const effC = g.effectivePosture({ collection: 'c', field: 'c' })
    expect(effB?.encryptedAtRest).toBe('sealed')
    expect(effC?.encryptedAtRest).toBe('sealed')
    expect(effC?.exportable).toBe(false)
    expect(effC?.forgettable).toBe(true)
  })

  it('cross-collection sources are folded too', () => {
    const g = new ViaGraph()
    g.registerField('orders', 'cardNumber', CLASSIFIED)
    g.registerDerived(
      { collection: 'reports', field: 'summary' },
      [{ collection: 'orders', field: 'cardNumber' }],
      'rollup',
      'aggregate',
    )
    expect(g.effectivePosture({ collection: 'reports', field: 'summary' })?.encryptedAtRest).toBe('sealed')
  })
})

describe('ViaGraph — cycle rejection (assertAcyclic)', () => {
  it('a self-referential derivation/computed cycle throws DerivationCycleError', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'c', field: 'x' }, [{ collection: 'c', field: 'x' }], 'derivation', 'record')
    expect(() => g.assertAcyclic()).toThrow(DerivationCycleError)
  })

  it('a self-referential MV-kind cycle throws MaterializedViewCycleError', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'c', field: 'x' }, [{ collection: 'c', field: 'x' }], 'mv', 'aggregate')
    expect(() => g.assertAcyclic()).toThrow(MaterializedViewCycleError)
  })

  it('a multi-node derivation cycle (a → b → c → a) throws DerivationCycleError', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'v', field: 'a' }, [{ collection: 'v', field: 'c' }], 'derivation', 'record')
    g.registerDerived({ collection: 'v', field: 'b' }, [{ collection: 'v', field: 'a' }], 'derivation', 'record')
    g.registerDerived({ collection: 'v', field: 'c' }, [{ collection: 'v', field: 'b' }], 'derivation', 'record')
    expect(() => g.assertAcyclic()).toThrow(DerivationCycleError)
  })

  it('a cycle where any participating node is MV-kind attributes to MaterializedViewCycleError', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'v', field: 'a' }, [{ collection: 'v', field: 'b' }], 'derivation', 'record')
    g.registerDerived({ collection: 'v', field: 'b' }, [{ collection: 'v', field: 'a' }], 'mv', 'aggregate')
    expect(() => g.assertAcyclic()).toThrow(MaterializedViewCycleError)
  })

  it('does not throw for an acyclic graph, including diamonds (shared source, two derived targets)', () => {
    const g = new ViaGraph()
    g.registerField('c', 'src', DEFAULT_POSTURE)
    g.registerDerived({ collection: 'c', field: 'a' }, [{ collection: 'c', field: 'src' }], 'computed', 'record')
    g.registerDerived({ collection: 'c', field: 'b' }, [{ collection: 'c', field: 'src' }], 'computed', 'record')
    g.registerDerived({ collection: 'c', field: 'ab' }, [{ collection: 'c', field: 'a' }, { collection: 'c', field: 'b' }], 'computed', 'record')
    expect(() => g.assertAcyclic()).not.toThrow()
  })

  it('the offending path is carried on the thrown error (behavior-lock shape)', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'c', field: 'x' }, [{ collection: 'c', field: 'x' }], 'derivation', 'record')
    try {
      g.assertAcyclic()
      expect.fail('expected assertAcyclic to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(DerivationCycleError)
      expect((e as DerivationCycleError).path.length).toBeGreaterThan(0)
      expect((e as DerivationCycleError).message).toMatch(/cycle/i)
    }
  })

  // #639 — mutual/rotating rollup cycles. Rollup edges are shaped
  // `(from,'*') → (into, field)`: the target is a REAL field node, so
  // pre-#639 the DFS (which only recurses through `_out.get(id)`) dead-ended
  // on it — nothing was ever sourced AT a rollup target — and the cycle was
  // invisible. The fix is a DFS-local containment expansion: visiting a real
  // field node `(C,f)` also expands `(C,'*')`'s out-edges (a write to a real
  // field is a write to the collection, which triggers every whole-record
  // dependent of it).
  it('a mutual rollup cycle (A rollup B.x, B rollup A.y) is now caught — was silently accepted pre-#639', () => {
    const g = new ViaGraph()
    // "A rollup into B.x": B.x aggregates A's children.
    g.registerDerived({ collection: 'B', field: 'x' }, [{ collection: 'A', field: '*' }], 'rollup', 'aggregate')
    // "B rollup into A.y": A.y aggregates B's children.
    g.registerDerived({ collection: 'A', field: 'y' }, [{ collection: 'B', field: '*' }], 'rollup', 'aggregate')
    expect(() => g.assertAcyclic()).toThrow(DerivationCycleError)
  })

  it('the mutual-rollup cycle path names both real field nodes (message-shape pin)', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'B', field: 'x' }, [{ collection: 'A', field: '*' }], 'rollup', 'aggregate')
    g.registerDerived({ collection: 'A', field: 'y' }, [{ collection: 'B', field: '*' }], 'rollup', 'aggregate')
    try {
      g.assertAcyclic()
      expect.fail('expected assertAcyclic to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(DerivationCycleError)
      const path = (e as DerivationCycleError).path
      // No '*' hop is surfaced for a pure rollup↔rollup cycle — containment
      // is inlined into the visiting field node's neighbour set, never
      // itself pushed onto the traversal stack — so the message reads as a
      // plain field-to-field chain, comprehensible without annotation.
      expect(path).toContain('A.y')
      expect(path).toContain('B.x')
      expect(path.some(p => p.includes('*'))).toBe(false)
      expect((e as DerivationCycleError).message).toMatch(/^Derivation graph contains a cycle: .*→.*Refusing to open vault/)
    }
  })

  it('a three-collection rollup rotation (A→B.x, B→C.y, C→A.z) is also caught', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'B', field: 'x' }, [{ collection: 'A', field: '*' }], 'rollup', 'aggregate')
    g.registerDerived({ collection: 'C', field: 'y' }, [{ collection: 'B', field: '*' }], 'rollup', 'aggregate')
    g.registerDerived({ collection: 'A', field: 'z' }, [{ collection: 'C', field: '*' }], 'rollup', 'aggregate')
    expect(() => g.assertAcyclic()).toThrow(DerivationCycleError)
  })

  it('an acyclic rollup chain (A→B.x; B→C.z) still declares fine (control)', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'B', field: 'x' }, [{ collection: 'A', field: '*' }], 'rollup', 'aggregate')
    g.registerDerived({ collection: 'C', field: 'z' }, [{ collection: 'B', field: '*' }], 'rollup', 'aggregate')
    expect(() => g.assertAcyclic()).not.toThrow()
  })

  // #671 item 5 — `assertAcyclic`'s DFS walked `_out` with no filtering by edge kind, so a
  // legal mutual FK lookup (two collections each referencing the other via a `kind:'ref'`
  // edge) spuriously threw `DerivationCycleError`. `neighboursOf` must exclude `'ref'`-kind
  // consuming edges — mutual FKs are legal; ref edges exist for cascade/rename machinery
  // (`referencingEdgesOf`/delete-time restrict/cascade/nullify), not derivation ordering.
  it('mutual kind:\'ref\' edges (legal mutual FK lookups) do NOT throw — ref edges are not derivation-ordering edges (#671 item 5)', () => {
    const g = new ViaGraph()
    // Mirrors registerLookupRefEdges' call shape (via/lookup/registry.ts:471-473):
    // graph.registerDerived(referencing, sources, 'ref', 'record', onDelete, keyField).
    g.registerDerived({ collection: 'customers', field: 'homeCountry' }, [{ collection: 'countries', field: '*' }], 'ref', 'record', 'restrict', 'id')
    g.registerDerived({ collection: 'countries', field: 'capitalOf' }, [{ collection: 'customers', field: '*' }], 'ref', 'record', 'restrict', 'id')
    expect(() => g.assertAcyclic()).not.toThrow()
  })

  it('a genuine derived (non-ref) cycle still throws — the ref-edge filter does not blanket-exempt every cycle', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'w', field: 'a' }, [{ collection: 'w', field: 'b' }], 'derivation', 'record')
    g.registerDerived({ collection: 'w', field: 'b' }, [{ collection: 'w', field: 'a' }], 'derivation', 'record')
    expect(() => g.assertAcyclic()).toThrow(DerivationCycleError)
  })

  it('a mixed shape where the only cycle-closing edge is a ref edge does not throw', () => {
    const g = new ViaGraph()
    // B.y is a genuine derivation sourced from A.x...
    g.registerDerived({ collection: 'B', field: 'y' }, [{ collection: 'A', field: 'x' }], 'derivation', 'record')
    // ...and A.x is itself a lookup-ref field pointing back at B.y — the ONLY edge that
    // would close the loop is this ref edge, so it must not throw.
    g.registerDerived({ collection: 'A', field: 'x' }, [{ collection: 'B', field: 'y' }], 'ref', 'record', 'restrict', 'id')
    expect(() => g.assertAcyclic()).not.toThrow()
  })

  // #671 item 5 review — pins the WILDCARD-SLICE half of the ref-edge filter
  // (`neighboursOf`'s `wildcard` variable, graph.ts:242) as distinct from the own-slice
  // filter (`own`, graph.ts:239): mutation evidence showed reverting JUST the wildcard half
  // still passed the whole suite, because no existing fixture put a REAL (non-wildcard)
  // field in a position to inherit a ref edge via ITS OWN collection's '*' containment slice
  // while that ref edge's target also closes a cycle back to it via a genuine (non-ref) edge.
  it('a real field inherits a ref edge only through its collection\'s wildcard containment slice — the ref edge must still be excluded there too, so assertAcyclic() does NOT throw (#671 item 5, wildcard-slice half of the filter)', () => {
    const g = new ViaGraph()
    // countries.name is itself a derivation SOURCE (customers.countryName derives from it) —
    // a real, non-wildcard field the top-level DFS visits directly via `_out.keys()`.
    g.registerDerived({ collection: 'customers', field: 'countryName' }, [{ collection: 'countries', field: 'name' }], 'derivation', 'record')
    // A ref edge sourced at countries' wildcard ('*') slice — customers.homeCountry is a
    // lookup-ref field pointing at the countries dimension (mirrors registerLookupRefEdges'
    // call shape). countries.name's OWN out-edges never reach customers.homeCountry — it is
    // reachable ONLY via containment inheritance from countries.* here.
    g.registerDerived({ collection: 'customers', field: 'homeCountry' }, [{ collection: 'countries', field: '*' }], 'ref', 'record', 'restrict', 'id')
    // customers.homeCountry is ALSO a genuine (non-ref) derivation source for countries.name —
    // closing a cycle back to countries.name, but ONLY reachable from countries.name via the
    // wildcard-inherited ref edge above (never through countries.name's own out-edges).
    g.registerDerived({ collection: 'countries', field: 'name' }, [{ collection: 'customers', field: 'homeCountry' }], 'derivation', 'record')
    expect(() => g.assertAcyclic()).not.toThrow()
  })

  // #678 — `_in` is single-slot per target: `registerDerived`'s `_in.set` REPLACES the
  // whole edge, so a dual-role target (e.g. a `computed(fn,{deps})` field ALSO composed
  // with a lookup/ref, #631's exempt {computed, lookup} pair) that registers computed
  // FIRST then ref SECOND (mirrors the real call order, graph-wiring.ts:71-72 →
  // vault.ts:1168, both inside the same `vault.collection()` call) has its `_in` entry's
  // `kind` overwritten from 'computed' to 'ref'. `assertAcyclic`'s pre-fix ref-edge filter
  // asked `_in.get(nodeId(t))?.kind !== 'ref'` — the TARGET's current (post-overwrite)
  // kind, not the SPECIFIC edge's kind — so it wrongly excluded the dual-role target from
  // the DFS, hiding a genuine derivation cycle through its computed edge.
  it('a dual-role target (computed THEN ref, #631 composition order) does not hide a genuine derivation cycle through its computed edge (#678)', () => {
    const g = new ViaGraph()
    // T is dual-role: a computed field (sourced from A) ALSO composed with a ref/lookup
    // edge (sourced from B) — registered computed-first, ref-second, mirroring the real
    // vault.ts:1167→1168 order.
    g.registerDerived({ collection: 'c', field: 'T' }, [{ collection: 'c', field: 'A' }], 'computed', 'record')
    g.registerDerived({ collection: 'c', field: 'T' }, [{ collection: 'c', field: 'B' }], 'ref', 'record', 'restrict', 'id')
    // A genuine cycle through T's COMPUTED edge: A depends on T, T depends on A.
    g.registerDerived({ collection: 'c', field: 'A' }, [{ collection: 'c', field: 'T' }], 'computed', 'record')
    expect(() => g.assertAcyclic()).toThrow(DerivationCycleError)
  })

  it('companion: a legitimate mutual-FK ref-only cycle still does NOT throw even alongside the dual-role fix (#671 behavior preserved, #678)', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'customers', field: 'homeCountry' }, [{ collection: 'countries', field: '*' }], 'ref', 'record', 'restrict', 'id')
    g.registerDerived({ collection: 'countries', field: 'capitalOf' }, [{ collection: 'customers', field: '*' }], 'ref', 'record', 'restrict', 'id')
    expect(() => g.assertAcyclic()).not.toThrow()
  })
})

describe('ViaGraph — taintedPostures / taintSealedFields (Task 3 overlay)', () => {
  it('taintedPostures returns a field → effectivePosture map scoped to one collection', () => {
    const g = new ViaGraph()
    g.registerField('c', 'ssn', CLASSIFIED)
    g.registerDerived({ collection: 'c', field: 'total' }, [{ collection: 'c', field: 'ssn' }], 'computed', 'record')
    g.registerDerived({ collection: 'other', field: 'ignored' }, [{ collection: 'c', field: 'ssn' }], 'computed', 'record')
    const postures = g.taintedPostures('c')
    expect(postures.size).toBe(1)
    expect(postures.get('total')).toEqual(foldPosture(DEFAULT_POSTURE, CLASSIFIED))
    expect(postures.get('ignored')).toBeUndefined()
  })

  it('taintSealedFields includes a materialized computed field with a sealed source, excludes a plain-source one', () => {
    const g = new ViaGraph()
    g.registerField('c', 'ssn', CLASSIFIED)
    g.registerField('c', 'name', DEFAULT_POSTURE)
    g.registerDerived({ collection: 'c', field: 'sealedDerived' }, [{ collection: 'c', field: 'ssn' }], 'computed', 'record')
    g.registerDerived({ collection: 'c', field: 'plainDerived' }, [{ collection: 'c', field: 'name' }], 'computed', 'record')
    const sealed = g.taintSealedFields('c')
    expect(sealed.has('sealedDerived')).toBe(true)
    expect(sealed.has('plainDerived')).toBe(false)
  })

  it('taintProvenance names the immediate source(s) that forced a target away from DEFAULT_POSTURE, scoped per collection', () => {
    const g = new ViaGraph()
    g.registerField('c', 'ssn', CLASSIFIED)
    g.registerField('c', 'name', DEFAULT_POSTURE)
    g.registerDerived({ collection: 'c', field: 'total' }, [{ collection: 'c', field: 'ssn' }], 'computed', 'record')
    g.registerDerived({ collection: 'c', field: 'plainDerived' }, [{ collection: 'c', field: 'name' }], 'computed', 'record')
    g.registerDerived({ collection: 'other', field: 'ignored' }, [{ collection: 'c', field: 'ssn' }], 'computed', 'record')
    const provenance = g.taintProvenance('c')
    expect(provenance.get('total')).toEqual(['ssn'])
    expect(provenance.get('plainDerived')).toBeUndefined() // nothing forced it — pure DEFAULT_POSTURE
    expect(provenance.get('ignored')).toBeUndefined() // scoped to 'c', not 'other'
  })

  it('taintProvenance names only the restrictive source(s) out of multiple, and transitively through a chain', () => {
    const g = new ViaGraph()
    g.registerField('c', 'ssn', CLASSIFIED)
    g.registerField('c', 'price', MONEY)
    g.registerField('c', 'name', DEFAULT_POSTURE)
    g.registerDerived(
      { collection: 'c', field: 'combo' },
      [{ collection: 'c', field: 'ssn' }, { collection: 'c', field: 'price' }, { collection: 'c', field: 'name' }],
      'computed',
      'record',
    )
    expect(g.taintProvenance('c').get('combo')).toEqual(['ssn', 'price']) // 'name' contributed nothing

    g.registerDerived({ collection: 'c', field: 'b' }, [{ collection: 'c', field: 'ssn' }], 'computed', 'record')
    g.registerDerived({ collection: 'c', field: 'c2' }, [{ collection: 'c', field: 'b' }], 'computed', 'record')
    expect(g.taintProvenance('c').get('c2')).toEqual(['b']) // immediate source named, not the ultimate 'ssn'
  })
})

describe('ViaGraph — dependentsOf / derivedArtifactsOf (Task 4/6 overlays)', () => {
  it('dependentsOf enumerates every derived target with at least one source in the given collection', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'reports', field: 'r1' }, [{ collection: 'orders', field: 'amount' }], 'rollup', 'aggregate')
    g.registerDerived({ collection: 'reports', field: 'r2' }, [{ collection: 'orders', field: 'amount' }, { collection: 'customers', field: 'name' }], 'derivation', 'record')
    g.registerDerived({ collection: 'unrelated', field: 'u' }, [{ collection: 'customers', field: 'name' }], 'computed', 'record')

    const deps = g.dependentsOf('orders')
    expect(deps).toHaveLength(2)
    expect(deps.map(d => d.target)).toEqual(
      expect.arrayContaining([
        { collection: 'reports', field: 'r1' },
        { collection: 'reports', field: 'r2' },
      ]),
    )
    const r1 = deps.find(d => d.target.field === 'r1')
    expect(r1?.kind).toBe('rollup')
    expect(r1?.grain).toBe('aggregate')
  })

  it('dependentsOf returns an empty array for a collection with no dependents', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'reports', field: 'r1' }, [{ collection: 'orders', field: 'amount' }], 'rollup', 'aggregate')
    expect(g.dependentsOf('customers')).toEqual([])
  })

  it('derivedArtifactsOf enumerates the same shape for erasure fanout', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'mv-out', field: 'row' }, [{ collection: 'customers', field: 'ssn' }], 'mv', 'record')
    const artifacts = g.derivedArtifactsOf('customers')
    expect(artifacts).toEqual([
      { target: { collection: 'mv-out', field: 'row' }, kind: 'mv', grain: 'record' },
    ])
  })

  it('dependentsOf excludes ref edges (the sync/cutover/restore dispatch wave never needs them); derivedArtifactsOf still includes them (erasure fanout does) — #650 Task 5 review, folded Minor', () => {
    const g = new ViaGraph()
    g.registerDerived({ collection: 'travelers', field: 'country' }, [{ collection: 'countries', field: '*' }], 'ref', 'record', 'cascade', 'id')
    g.registerDerived({ collection: 'reports', field: 'r1' }, [{ collection: 'countries', field: 'name' }], 'rollup', 'aggregate')

    const deps = g.dependentsOf('countries')
    expect(deps).toHaveLength(1)
    expect(deps.map(d => d.kind)).toEqual(['rollup']) // the 'ref' edge is excluded

    const artifacts = g.derivedArtifactsOf('countries')
    expect(artifacts).toHaveLength(2) // both 'ref' and 'rollup' — erasure fanout needs the 'ref' edge
    expect(artifacts.map(a => a.kind).sort()).toEqual(['ref', 'rollup'])
  })
})
