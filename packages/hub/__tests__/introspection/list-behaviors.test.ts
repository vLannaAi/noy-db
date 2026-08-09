import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'
import { createNoydb, withGuard, withDerivation, withMaterializedView, withOverlayedView, immutableGuard } from '../../src/index.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

interface Invoice extends Record<string, unknown> { id: string; client_id: string; amount: number; status?: string }

describe('vault.listBehaviors() (#947 Task 3)', () => {
  it('returns empty arrays for a vault with no behaviors registered', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw' })
    const vault = await db.openVault('acme')
    const summary = vault.listBehaviors()
    expect(summary).toEqual({ guards: [], derivations: [], materializedViews: [], overlays: [], satellites: [] })
  })

  it('enumerates a named guard, a named derivation, an MV, an overlay, and a satellite — names + serializable spec halves, no function leaks', async () => {
    const guardCheck = () => {}
    const guardHandle = withGuard<Invoice>({
      name: 'invoice-guard',
      collection: 'invoices',
      check: guardCheck,
      frozenFields: { when: (r) => r.status === 'issued', fields: ['amount'] },
    })

    const deriveFn = (s: Invoice) => ({ meta: { total: s.amount } })
    const derivationHandle = withDerivation({
      name: 'invoice-meta',
      source: 'invoices',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'invoice-meta' } },
      derive: deriveFn,
      lifecycle: 'eager',
    })

    const rowKeyFn = (r: { client_id: string }) => r.client_id
    const mvHandle = withMaterializedView<{ client_id: string; amount: number }>({
      name: 'invoice-by-client',
      query: (db) => db.collection<Invoice>('invoices').query(),
      rowKey: rowKeyFn,
      refresh: 'eager',
    })

    const overlayHandle = withOverlayedView({
      name: 'invoice-view',
      base: 'invoice-by-client',
      overlay: 'invoice-overrides',
      shadowField: 'dataStatus',
      shadowValue: 'override',
    })

    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'pw',
      guardStrategies: [guardHandle],
      derivationStrategies: [derivationHandle],
      materializedViewStrategies: [mvHandle],
      overlayedViewStrategies: [overlayHandle],
    })
    const vault = await db.openVault('acme')
    vault.collection<{ subject: string }>('msgs')
    vault.collection<{ subject: string }>('msgs_text', { satelliteOf: 'msgs', fields: ['subject'], joined: 'msgs_full' })

    const summary = vault.listBehaviors()

    // guards
    expect(summary.guards).toHaveLength(1)
    const guard = summary.guards[0]!
    expect(guard.name).toBe('invoice-guard')
    expect(guard.collection).toBe('invoices')
    expect(guard.frozenFields).toEqual({ fields: ['amount'] })
    expect('check' in guard).toBe(false)
    expect('onDelete' in guard).toBe(false)
    expect((guard.frozenFields as { when?: unknown })?.when).toBeUndefined()

    // derivations
    expect(summary.derivations).toHaveLength(1)
    const derivation = summary.derivations[0]!
    expect(derivation.name).toBe('invoice-meta')
    expect(derivation.source).toBe('invoices')
    expect(derivation.outputs['meta']).toEqual({ shape: 'record', collection: 'invoice-meta' })
    expect(derivation.deterministic).toBe(true)
    expect('derive' in derivation).toBe(false)

    // materialized views
    expect(summary.materializedViews).toHaveLength(1)
    const mv = summary.materializedViews[0]!
    expect(mv.name).toBe('invoice-by-client')
    expect(mv.spec['name']).toBe('invoice-by-client')
    expect(mv.spec['refresh']).toBe('eager')
    expect('query' in mv.spec).toBe(false)
    expect('rowKey' in mv.spec).toBe(false)

    // overlays
    expect(summary.overlays).toHaveLength(1)
    const overlay = summary.overlays[0]!
    expect(overlay.name).toBe('invoice-view')
    expect(overlay.base).toBe('invoice-by-client')
    expect(overlay.overlay).toBe('invoice-overrides')
    expect(overlay.shadowField).toBe('dataStatus')
    expect(overlay.shadowValue).toBe('override')

    // satellites
    expect(summary.satellites).toHaveLength(1)
    const satellite = summary.satellites[0]!
    expect(satellite.name).toBe('msgs_text')
    expect(satellite.base).toBe('msgs')
    expect(satellite.fields).toEqual(['subject'])
    expect(satellite.joined).toBe('msgs_full')

    // full-object JSON round-trip — no function anywhere in the summary
    expect(() => JSON.stringify(summary)).not.toThrow()
    const roundTripped = JSON.parse(JSON.stringify(summary)) as unknown
    expect(roundTripped).toEqual(summary)
  })

  it('assigns a deterministic fallback name to an unnamed guard, scoped per collection', async () => {
    const guardA = withGuard<Invoice>({ collection: 'invoices', check: () => {} })
    const guardB = withGuard<Invoice>({ collection: 'invoices', check: () => {} })

    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'pw',
      guardStrategies: [guardA, guardB],
    })
    const vault = await db.openVault('acme')

    const names = vault.listBehaviors().guards.map((g) => g.name)
    expect(names).toEqual(['invoices#1', 'invoices#2'])
  })

  it('assigns a deterministic fallback name to an unnamed derivation, mirroring dumpSchema\'s key convention', async () => {
    const derivationHandle = withDerivation({
      source: 'widgets',
      deterministic: true,
      outputs: { entry: { shape: 'record', collection: 'catalogEntry' } },
      derive: (s: Invoice) => ({ entry: { id: s.id } }),
      lifecycle: 'eager',
    })

    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'pw',
      derivationStrategies: [derivationHandle],
    })
    const vault = await db.openVault('acme')

    const names = vault.listBehaviors().derivations.map((d) => d.name)
    expect(names).toEqual(['catalogEntry'])
  })

  it('an explicit guard name matching another unnamed guard\'s fallback key does not produce a duplicate name (#973)', async () => {
    const explicitGuard = withGuard<Invoice>({ name: 'invoices#1', collection: 'invoices', check: () => {} })
    const unnamedA = withGuard<Invoice>({ collection: 'invoices', check: () => {} })
    const unnamedB = withGuard<Invoice>({ collection: 'invoices', check: () => {} })

    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'pw',
      guardStrategies: [explicitGuard, unnamedA, unnamedB],
    })
    const vault = await db.openVault('acme')

    const names = vault.listBehaviors().guards.map((g) => g.name)
    expect(names).toHaveLength(3)
    expect(new Set(names).size).toBe(3)
    expect(names).toContain('invoices#1')
  })

  it('forwards an immutableGuard `name` into the manifest instead of the positional fallback (#1006)', async () => {
    const namedImmutable = immutableGuard<Invoice>({
      name: 'invoice-append-only',
      collection: 'invoices',
      appendOnly: true,
    })

    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'pw',
      guardStrategies: [namedImmutable],
    })
    const vault = await db.openVault('acme')

    const names = vault.listBehaviors().guards.map((g) => g.name)
    expect(names).toEqual(['invoice-append-only'])
  })

  it('keeps the positional fallback for an immutableGuard that omits `name` (#1006)', async () => {
    const unnamedImmutable = immutableGuard<Invoice>({ collection: 'invoices', appendOnly: true })

    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'pw',
      guardStrategies: [unnamedImmutable],
    })
    const vault = await db.openVault('acme')

    expect(vault.listBehaviors().guards.map((g) => g.name)).toEqual(['invoices#1'])
  })

  it('an immutableGuard name is stable when an unrelated guard is registered ahead of it (#1006)', async () => {
    const namedImmutable = immutableGuard<Invoice>({
      name: 'invoice-append-only',
      collection: 'invoices',
      appendOnly: true,
    })
    const interloper = withGuard<Invoice>({ collection: 'invoices', check: () => {} })

    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'pw',
      guardStrategies: [interloper, namedImmutable],
    })
    const vault = await db.openVault('acme')

    // Registration order changed; the immutable guard's identity must not.
    const entry = vault.listBehaviors().guards.find((g) => g.name === 'invoice-append-only')
    expect(entry).toBeDefined()
    expect(entry?.collection).toBe('invoices')
  })
})
