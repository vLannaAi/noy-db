import { describe, it, expect } from 'vitest'
import {
  createNoydb,
  withDerivation,
  withRollup,
  withMaterializedView,
  DerivationCycleError,
  MaterializedViewCycleError,
  ValidationError,
} from '../../src/index.js'
import { classified } from '../../src/via/classified/presets.js'
import { i18nText } from '../../src/via/i18n/core.js'
import { resolveComputedEdges, resolveViaBindingDepsEdges } from '../../src/kernel/collection-config.js'
import { DEFAULT_POSTURE } from '../../src/kernel/via/graph.js'
import type { ViaBinding } from '../../src/kernel/via/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'
import type { ClassifiedFieldSpec } from '../../src/via/classified/index.js'

/** A `storage: 'never'` spec-literal (mirrors classified/threading.test.ts's
 *  `neverSpec`) — safe to declare on the reconcile path (post auto-creation),
 *  unlike the shipped presets (all recoverable/digest-only, which the
 *  reconcile path independently refuses for an unrelated sealing reason). */
const neverSpec = (): ClassifiedFieldSpec => ({
  _noydbClassified: true, preset: 'test', storage: 'never',
  list: { kind: 'omit' }, sensitivity: 'secret',
})

function toMemory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/')
        if (vname === v && cname !== undefined && id !== undefined) {
          out[cname] = out[cname] ?? {}
          out[cname]![id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) {
          data.set(k(v, c, i), payload[c]![i]!)
        }
      }
    },
  }
}

describe('vault.graph — edge sources go live (#638 Task 2)', () => {
  it('registers derivation, rollup, and MV edges; dependentsOf/effectivePosture reflect them', async () => {
    const pdfDerivation = withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => ({ meta: {} }),
      lifecycle: 'eager',
    })
    interface Item extends Record<string, unknown> { orderId: string; amount?: number }
    const rollup = withRollup<Item, { total: number }>({
      from: 'items',
      key: 'orderId',
      into: 'orders',
      field: 'total',
      compute: (children) => children.reduce((s, c) => s + (c.amount ?? 0), 0),
    })
    const mv = withMaterializedView<{ id: string; tag: string }>({
      name: 'red-products',
      query: (db) => db.collection<{ id: string; tag: string }>('products').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'graph-edges-fixture-secret-2026',
      derivationStrategies: [pdfDerivation, rollup],
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')

    // (c) with-formula — derivation edge.
    const pdfDeps = vault.graph.dependentsOf('pdfs')
    expect(pdfDeps.some((d) => d.target.collection === 'pdf-meta' && d.kind === 'derivation')).toBe(true)

    // (c) with-formula — rollup edge (aggregate grain, real target field).
    const itemDeps = vault.graph.dependentsOf('items')
    const rollupEdge = itemDeps.find((d) => d.kind === 'rollup')
    expect(rollupEdge?.target).toEqual({ collection: 'orders', field: 'total' })
    expect(rollupEdge?.grain).toBe('aggregate')

    // (c) with-formula — MV edge (record grain, whole-record artifact target).
    const productDeps = vault.graph.dependentsOf('products')
    const mvEdge = productDeps.find((d) => d.kind === 'mv')
    expect(mvEdge?.target.collection).toBe('red-products')
    expect(mvEdge?.grain).toBe('record')

    // (b) computed — a computed field's declared deps feed the graph; the
    // classified source's sealed/non-export/non-query posture propagates.
    vault.collection('customers', {
      classifiedFields: { ssn: classified.email() },
      computed: { total: { fn: (r: Record<string, unknown>) => String(r.ssn).length, deps: ['ssn'] } },
    })
    const posture = vault.graph.effectivePosture({ collection: 'customers', field: 'total' })
    expect(posture?.encryptedAtRest).toBe('sealed')
    expect(posture?.exportable).toBe(false)
  })

  it('a derivation cycle still throws DerivationCycleError at vault open (new graph-based path)', async () => {
    const a = withDerivation({
      source: 'a', deterministic: true,
      outputs: { o: { shape: 'record', collection: 'b' } },
      derive: () => ({ o: {} }), lifecycle: 'eager',
    })
    const b = withDerivation({
      source: 'b', deterministic: true,
      outputs: { o: { shape: 'record', collection: 'a' } },
      derive: () => ({ o: {} }), lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'graph-edges-cycle-derivation-2026',
      derivationStrategies: [a, b],
    })
    await expect(db.openVault('demo')).rejects.toBeInstanceOf(DerivationCycleError)
  })

  it('an MV self-feedback cycle still throws MaterializedViewCycleError at vault open (new graph-based path)', async () => {
    interface Loopy extends Record<string, unknown> { id: string }
    const cyclic = withMaterializedView<Loopy>({
      name: 'self-feedback',
      query: (db) => db.collection<Loopy>('self-feedback').query(),
      rowKey: (r) => String(r.id),
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'graph-edges-cycle-mv-2026',
      materializedViewStrategies: [cyclic],
    })
    await expect(db.openVault('demo')).rejects.toBeInstanceOf(MaterializedViewCycleError)
  })

  it('a computed field\'s deps may reference a PLAIN field with no via feature at all (#638 Task 7 — no schema-introspection API to validate against; harmless, contributes no taint)', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'graph-edges-baddeps-2026' })
    const vault = await db.openVault('demo')
    expect(() =>
      vault.collection('bad-deps', {
        computed: { total: { fn: (r: Record<string, unknown>) => r.amount, deps: ['nope'] } },
      }),
    ).not.toThrow()
    // 'nope' was never registered via ANY via feature — the fold falls back to
    // DEFAULT_POSTURE, contributing no taint (verified by DEFAULT_POSTURE-shaped
    // effectivePosture below, mirroring `graph.test.ts`'s own default-posture pin).
    const posture = vault.graph.effectivePosture({ collection: 'bad-deps', field: 'total' })
    expect(posture).toEqual({ encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: false })
  })

  it('a depsless computed entry on a collection that also declares classified fields throws (closes the #636 opaque-function hole)', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'graph-edges-leak-2026' })
    const vault = await db.openVault('demo')
    expect(() =>
      vault.collection('leaky', {
        classifiedFields: { ssn: classified.email() },
        computed: { ssnLeak: (r: Record<string, unknown>) => r.ssn },
      }),
    ).toThrow(ValidationError)
  })

  it('a computed entry with a MISTYPED dep on a collection that also declares classified fields throws (Task 7 review CRITICAL fix — closes the typo reopening of #636: construction used to silently fold the derived field to DEFAULT_POSTURE)', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'graph-edges-typo-fresh-2026' })
    const vault = await db.openVault('demo')
    expect(() =>
      vault.collection('typo-leaky', {
        classifiedFields: { ssn: classified.email() },
        // 'sssn' — a typo for the declared classified field 'ssn'.
        computed: { ssnLeak: { fn: (r: Record<string, unknown>) => r.ssn, deps: ['sssn'] } },
      }),
    ).toThrow(ValidationError)
  })

  it('a depsless computed entry on a NON-classified collection is fine (no in-edges → no taint)', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'graph-edges-plain-2026' })
    const vault = await db.openVault('demo')
    expect(() =>
      vault.collection('plain', { computed: { doubled: (r: Record<string, unknown>) => Number(r.n) * 2 } }),
    ).not.toThrow()
  })

  it('a rider-computed classified companion (domain) is NOT subject to the depsless guard (sanctioned channel, #629 precedent)', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'graph-edges-rider-2026' })
    const vault = await db.openVault('demo')
    // classified.email() auto-derives a `domain` riderComputed companion —
    // this must NOT trip the depsless-on-classified guard (which only
    // applies to opts.computed, never resolvedClassified.riderComputed).
    expect(() => vault.collection('with-rider', { classifiedFields: { email: classified.email() } })).not.toThrow()
  })

  it('the MV-pre-creation reconcile path still runs the anti-leak guard (review fix — #638 Task 2)', async () => {
    // 'customers' is auto-pre-created BARE by the MV's query(db) callback
    // during openVault, before any real declaration exists for it.
    interface Row extends Record<string, unknown> { id: string }
    const mv = withMaterializedView<Row>({
      name: 'customer-rollup',
      query: (db) => db.collection<Row>('customers').query(),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'graph-edges-reconcile-leak-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')
    // Later, real declaration reconciles onto the bare-pre-created collection —
    // same depsless-computed-plus-classified config the fresh path refuses.
    expect(() =>
      vault.collection('customers', {
        classifiedFields: { ssn: neverSpec() },
        computed: { ssnLeak: (r: Record<string, unknown>) => r.ssn },
      }),
    ).toThrow(ValidationError)
  })

  it('the MV-pre-creation reconcile path registers a computed field\'s deps edges into vault.graph', async () => {
    interface Row extends Record<string, unknown> { id: string }
    const mv = withMaterializedView<Row>({
      name: 'customer-rollup-2',
      query: (db) => db.collection<Row>('customers2').query(),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'graph-edges-reconcile-valid-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')
    vault.collection('customers2', {
      classifiedFields: { ssn: neverSpec() },
      computed: { total: { fn: (r: Record<string, unknown>) => String(r.ssn).length, deps: ['ssn'] } },
    })
    const deps = vault.graph.dependentsOf('customers2')
    expect(deps.some((d) =>
      d.target.collection === 'customers2' && d.target.field === 'total' && d.kind === 'computed',
    )).toBe(true)
  })

  it('the MV-pre-creation reconcile path also refuses a MISTYPED computed dep on a newly-attached classified field (Task 7 review CRITICAL fix)', async () => {
    interface Row extends Record<string, unknown> { id: string }
    const mv = withMaterializedView<Row>({
      name: 'customer-rollup-typo',
      query: (db) => db.collection<Row>('customers-typo').query(),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'graph-edges-reconcile-typo-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')
    // 'customers-typo' is auto-pre-created BARE by the MV; this reconciles
    // both classifiedFields and a computed field whose `deps` typo's the
    // classified field's name ('sssn' instead of 'ssn') in the SAME call.
    expect(() =>
      vault.collection('customers-typo', {
        classifiedFields: { ssn: neverSpec() },
        computed: { ssnLeak: { fn: (r: Record<string, unknown>) => r.ssn, deps: ['sssn'] } },
      }),
    ).toThrow(ValidationError)
  })

  it('a two-call reconcile assembly (depsless computed first, classifiedFields second) still throws (fix wave 2, Finding I1)', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'graph-edges-order-a-2026' })
    const vault = await db.openVault('demo')
    // Call 1: fresh construction — legal, no classified fields exist yet.
    vault.collection('leaky2', {
      computed: { ssnLeak: (r: Record<string, unknown>) => r.ssn },
      sensitive: ['ssn'],
    })
    // Call 2: reconcile — attaches classifiedFields onto the SAME collection.
    // `sensitive: ['ssn']` above pre-freezes `sensitiveFields`, defusing
    // `_applyClassifiedFields`'s own "sealing is fixed at first open" refusal —
    // the ONLY thing that should refuse this is the combined-state leak guard.
    expect(() =>
      vault.collection('leaky2', { classifiedFields: { ssn: classified.email() } }),
    ).toThrow(ValidationError)
  })

  it('a repeated identical vault.collection() call is a no-op — no duplicate edges, no spurious i18n knownFields throw (fix wave 2, Finding I2)', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'graph-edges-repeat-2026' })
    const vault = await db.openVault('demo')
    const options = {
      i18nFields: { note: i18nText({ languages: ['en'], required: 'any' }) },
      computed: { total: { fn: (r: Record<string, unknown>) => String(r.note).length, deps: ['note'] } },
    }
    vault.collection('repeat-me', options) // fresh construction
    expect(() => vault.collection('repeat-me', options)).not.toThrow() // identical repeat — reconcile branch
    const deps = vault.graph.dependentsOf('repeat-me').filter((d) => d.target.field === 'total')
    expect(deps).toHaveLength(1) // not duplicated
  })

  it('a rejected reconcile call (classified storage-form transition refused) leaves no partial graph state (fix wave 2, Finding M2)', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'graph-edges-partial-2026' })
    const vault = await db.openVault('demo')
    vault.collection('partial', { classifiedFields: { ssn: neverSpec() } }) // storage: 'never'
    expect(() =>
      vault.collection('partial', {
        // storage: 'recoverable' — a form transition R6 refuses, AFTER the
        // computed edge would otherwise have been validated successfully.
        classifiedFields: { ssn: classified.email() },
        computed: { total: { fn: (r: Record<string, unknown>) => String(r.ssn).length, deps: ['ssn'] } },
      }),
    ).toThrow()
    const deps = vault.graph.dependentsOf('partial').filter((d) => d.target.field === 'total')
    expect(deps).toHaveLength(0)
  })

  it('a reconcile-attached classified field registers its sealed posture into the graph (fix wave 2, Finding M1)', async () => {
    interface Row extends Record<string, unknown> { id: string }
    const mv = withMaterializedView<Row>({
      name: 'customer-rollup-4',
      query: (db) => db.collection<Row>('customers4').query(),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'graph-edges-m1-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')
    // 'customers4' is auto-pre-created BARE by the MV; this reconciles both
    // classifiedFields and a computed field depending on the classified source.
    vault.collection('customers4', {
      classifiedFields: { ssn: neverSpec() },
      computed: { total: { fn: (r: Record<string, unknown>) => String(r.ssn).length, deps: ['ssn'] } },
    })
    const posture = vault.graph.effectivePosture({ collection: 'customers4', field: 'total' })
    expect(posture?.encryptedAtRest).toBe('sealed')
    expect(posture?.exportable).toBe(false)
  })

  it('3-call pin (cm7): fresh depsless computed → never-attach → recoverable-with-rider attach is a safe no-error outcome — the dangerous state never forms (#638 Task 3)', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'graph-edges-3call-2026' })
    const vault = await db.openVault('demo')
    // Call 1: fresh — a depsless computed field named 'email_domain', matching
    // classified.email()'s auto-derived rider companion name
    // (`resolveClassifiedFields`: companion = `${field}_${riderName}`).
    // Legal: no classified field exists yet.
    vault.collection('threehop', { computed: { email_domain: (r: Record<string, unknown>) => String(r.x).length } })
    // Call 2: attach a storage:'never' classified field — exempt from the
    // depsless-leak guard (never-storage can't reach a computed field, see
    // validateReconcileGraphEdges's doc comment), so this must not throw.
    // This is also what makes `this.classified` non-undefined going into call 3.
    expect(() => vault.collection('threehop', { classifiedFields: { other: neverSpec() } })).not.toThrow()
    // Call 3: attach a RECOVERABLE classified field whose auto-derived rider
    // companion name ('email_domain') collides with call 1's depsless field.
    // `_applyClassifiedFields`'s first-wins early return (collection.ts:1341,
    // reached because `this.classified` is already set from call 2) drops
    // this WHOLE incoming declaration — rider companions included — before
    // its own collision check (collection.ts:1347-1351) is ever reached, so
    // nothing new is merged for it to collide with. No error either way.
    expect(() => vault.collection('threehop', { classifiedFields: { email: classified.email() } })).not.toThrow()
    // The dangerous state never formed: 'email' was never actually attached
    // (dropped by the early return), so 'email_domain' stays an ordinary,
    // untainted computed field — not a channel for 'email' plaintext.
    expect(vault.graph.effectivePosture({ collection: 'threehop', field: 'email_domain' })).toBeUndefined()
  })

  it('#645 — a reconcile-attached computed field may reference a classified field declared in an EARLIER, separate call, without re-declaring it', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'graph-edges-645-cross-call-2026' })
    const vault = await db.openVault('demo')
    // Call 1: fresh construction — declares the classified field only.
    vault.collection('cross-call-deps', { classifiedFields: { ssn: classified.email() } })
    // Call 2: reconcile — attaches a computed field whose `deps` names 'ssn'
    // WITHOUT re-declaring classifiedFields. Before the #645 fix, the
    // reconcile path's knownFields universe was scoped to THIS call's own
    // options only (`collectKnownFieldNames`), so it had no memory of 'ssn'
    // — even though the graph already registered it from call 1 — and
    // spuriously refused with "does not name a declared field".
    expect(() =>
      vault.collection('cross-call-deps', {
        computed: { total: { fn: (r: Record<string, unknown>) => String(r.ssn).length, deps: ['ssn'] } },
      }),
    ).not.toThrow()
    const posture = vault.graph.effectivePosture({ collection: 'cross-call-deps', field: 'total' })
    expect(posture?.encryptedAtRest).toBe('sealed')
    expect(posture?.exportable).toBe(false)
  })

  it('#645 CONTROL: a reconcile-attached computed field with a genuinely UNKNOWN/mistyped dep still throws — the graph-memory union only adds ACTUALLY-registered fields', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'graph-edges-645-control-2026' })
    const vault = await db.openVault('demo')
    vault.collection('cross-call-typo', { classifiedFields: { ssn: classified.email() } })
    expect(() =>
      vault.collection('cross-call-typo', {
        // 'sssn' — a typo; never registered by any prior call, so it must
        // still be refused even with the graph's field memory unioned in.
        computed: { total: { fn: (r: Record<string, unknown>) => String(r.ssn).length, deps: ['sssn'] } },
      }),
    ).toThrow(ValidationError)
  })
})

describe('resolveViaBindingDepsEdges — the general via-bindings deps path (#638 Task 2)', () => {
  // No shipped binding declares `deps` today (money/i18n/classified/blob
  // don't) — these are direct unit tests of the general path a future
  // derive-bearing binding (phase C Task 7's `computed` via-binding) plugs
  // into (per the via/index.ts doc comment this task made truthful).
  function fixtureBinding(overrides: Partial<ViaBinding>): ViaBinding {
    return { brand: 'fixture', posture: DEFAULT_POSTURE, ...overrides }
  }

  it('a binding with no deps contributes no edges', () => {
    const binding = fixtureBinding({ covers: (f) => f === 'total' })
    expect(resolveViaBindingDepsEdges('customers', [binding], new Set(['total', 'ssn']))).toEqual([])
  })

  it('a binding declaring deps registers an edge for every field it covers', () => {
    const binding = fixtureBinding({ deps: ['ssn'], covers: (f) => f === 'total' })
    const edges = resolveViaBindingDepsEdges('customers', [binding], new Set(['total', 'ssn']))
    expect(edges).toEqual([
      { target: { collection: 'customers', field: 'total' }, sources: [{ collection: 'customers', field: 'ssn' }] },
    ])
  })

  it('an unknown deps source field throws declare-time ValidationError', () => {
    const binding = fixtureBinding({ deps: ['nope'], covers: () => true })
    expect(() => resolveViaBindingDepsEdges('customers', [binding], new Set(['total']))).toThrow(ValidationError)
  })
})

describe('resolveComputedEdges — well-formedness (#638 Task 2; #638 Task 7 folded computedDeps into each entry)', () => {
  it('rejects a non-string / empty deps entry', () => {
    expect(() =>
      resolveComputedEdges('c', { total: { fn: () => 1, deps: [''] } }, false),
    ).toThrow(ValidationError)
  })

  it('rejects an empty deps array', () => {
    expect(() =>
      resolveComputedEdges('c', { total: { fn: () => 1, deps: [] } }, false),
    ).toThrow(ValidationError)
  })

  it('a well-formed deps entry resolves to one edge, grain "record" (materialized default) — a plain, non-via dep field is legal (#638 Task 7)', () => {
    const edges = resolveComputedEdges('c', { total: { fn: () => 1, deps: ['amount'] } }, false)
    expect(edges).toEqual([{ target: { collection: 'c', field: 'total' }, sources: [{ collection: 'c', field: 'amount' }], grain: 'record' }])
  })

  it('a mode: "virtual" entry resolves to grain "virtual"', () => {
    const edges = resolveComputedEdges('c', { total: { fn: () => 1, deps: ['amount'], mode: 'virtual' } }, false)
    expect(edges).toEqual([{ target: { collection: 'c', field: 'total' }, sources: [{ collection: 'c', field: 'amount' }], grain: 'virtual' }])
  })

  // Task 7 review CRITICAL fix — the 4th (`knownFields`) param, consulted
  // ONLY when `hasClassifiedFields` is true.
  it('CONTROL: a deps entry naming a KNOWN field on a classified collection is legal', () => {
    const edges = resolveComputedEdges('c', { total: { fn: () => 1, deps: ['ssn'] } }, true, new Set(['ssn']))
    expect(edges).toEqual([{ target: { collection: 'c', field: 'total' }, sources: [{ collection: 'c', field: 'ssn' }], grain: 'record' }])
  })

  it('a deps entry naming an UNKNOWN field on a classified collection throws ValidationError (the typo-reopening fix)', () => {
    expect(() =>
      resolveComputedEdges('c', { total: { fn: () => 1, deps: ['sssn'] } }, true, new Set(['ssn'])),
    ).toThrow(ValidationError)
  })

  it('CONTROL: a deps entry naming an unknown field on a NON-classified collection stays legal (#638 Task 7 freedom preserved, `knownFields` ignored)', () => {
    const edges = resolveComputedEdges('c', { total: { fn: () => 1, deps: ['nope'] } }, false, new Set(['ssn']))
    expect(edges).toEqual([{ target: { collection: 'c', field: 'total' }, sources: [{ collection: 'c', field: 'nope' }], grain: 'record' }])
  })
})
