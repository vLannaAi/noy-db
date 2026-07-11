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
import { classified } from '../../src/shape/via-classified/presets.js'
import { resolveComputedEdges, resolveViaBindingDepsEdges } from '../../src/kernel/collection-config.js'
import { DEFAULT_POSTURE } from '../../src/kernel/via-graph.js'
import type { ViaBinding } from '../../src/kernel/via.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function memory(): NoydbStore {
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
      store: memory(),
      user: 'alice',
      secret: 'graph-edges-fixture-passphrase-2026',
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
      computed: { total: (r: Record<string, unknown>) => String(r.ssn).length },
      computedDeps: { total: ['ssn'] },
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
      store: memory(), user: 'alice', secret: 'graph-edges-cycle-derivation-2026',
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
      store: memory(), user: 'alice', secret: 'graph-edges-cycle-mv-2026',
      materializedViewStrategies: [cyclic],
    })
    await expect(db.openVault('demo')).rejects.toBeInstanceOf(MaterializedViewCycleError)
  })

  it('computedDeps referencing an undeclared field throws declare-time ValidationError', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'graph-edges-baddeps-2026' })
    const vault = await db.openVault('demo')
    expect(() =>
      vault.collection('bad-deps', {
        computed: { total: (r: Record<string, unknown>) => r.amount },
        computedDeps: { total: ['nope'] },
      }),
    ).toThrow(ValidationError)
  })

  it('a depsless computed entry on a collection that also declares classified fields throws (closes the #636 opaque-function hole)', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'graph-edges-leak-2026' })
    const vault = await db.openVault('demo')
    expect(() =>
      vault.collection('leaky', {
        classifiedFields: { ssn: classified.email() },
        computed: { ssnLeak: (r: Record<string, unknown>) => r.ssn },
      }),
    ).toThrow(ValidationError)
  })

  it('a depsless computed entry on a NON-classified collection is fine (no in-edges → no taint)', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'graph-edges-plain-2026' })
    const vault = await db.openVault('demo')
    expect(() =>
      vault.collection('plain', { computed: { doubled: (r: Record<string, unknown>) => Number(r.n) * 2 } }),
    ).not.toThrow()
  })

  it('a rider-computed classified companion (domain) is NOT subject to the depsless guard (sanctioned channel, #629 precedent)', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'graph-edges-rider-2026' })
    const vault = await db.openVault('demo')
    // classified.email() auto-derives a `domain` riderComputed companion —
    // this must NOT trip the depsless-on-classified guard (which only
    // applies to opts.computed, never resolvedClassified.riderComputed).
    expect(() => vault.collection('with-rider', { classifiedFields: { email: classified.email() } })).not.toThrow()
  })
})

describe('resolveViaBindingDepsEdges — the general via-bindings deps path (#638 Task 2)', () => {
  // No shipped binding declares `deps` today (money/i18n/classified/blob
  // don't) — these are direct unit tests of the general path a future
  // derive-bearing binding (phase C Task 7's `computed` via-binding) plugs
  // into (per the via.ts doc comment this task made truthful).
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

describe('resolveComputedEdges — well-formedness (#638 Task 2)', () => {
  it('rejects a non-string / empty deps entry', () => {
    expect(() =>
      resolveComputedEdges('c', { total: () => 1 }, { total: [''] }, new Set(['total']), false),
    ).toThrow(ValidationError)
  })

  it('rejects an empty deps array', () => {
    expect(() =>
      resolveComputedEdges('c', { total: () => 1 }, { total: [] }, new Set(['total']), false),
    ).toThrow(ValidationError)
  })

  it('a well-formed deps entry resolves to one edge', () => {
    const edges = resolveComputedEdges('c', { total: () => 1 }, { total: ['amount'] }, new Set(['total', 'amount']), false)
    expect(edges).toEqual([{ target: { collection: 'c', field: 'total' }, sources: [{ collection: 'c', field: 'amount' }] }])
  })
})
