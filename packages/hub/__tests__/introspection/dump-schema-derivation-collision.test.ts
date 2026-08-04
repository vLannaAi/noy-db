import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'
import { createNoydb, withDerivation } from '../../src/index.js'

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

interface Widget extends Record<string, unknown> { id: string; name: string }
interface Gadget extends Record<string, unknown> { id: string; name: string }

describe('vault.dumpSchema() — derivation key collisions (#947)', () => {
  it('two UNNAMED derivations sharing the same output set both appear, via a collision-safe suffix key', async () => {
    const widgetHandle = withDerivation({
      source: 'widgets',
      deterministic: true,
      outputs: { entry: { shape: 'record', collection: 'catalogEntry' } },
      derive: (s: Widget) => ({ entry: { id: s.id, kind: 'widget' } }),
      lifecycle: 'eager',
    })
    const gadgetHandle = withDerivation({
      source: 'gadgets',
      deterministic: true,
      outputs: { entry: { shape: 'record', collection: 'catalogEntry' } },
      derive: (s: Gadget) => ({ entry: { id: s.id, kind: 'gadget' } }),
      lifecycle: 'eager',
    })

    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'pw',
      derivationStrategies: [widgetHandle, gadgetHandle],
    })
    const vault = await db.openVault('acme')

    const snap = await vault.dumpSchema()

    // Both must appear — today one silently overwrites the other because
    // both key as 'catalogEntry'.
    expect(Object.keys(snap.derivations)).toHaveLength(2)

    const widgetEntry = snap.derivations['catalogEntry']
    expect(widgetEntry).toBeDefined()
    expect(widgetEntry!.source).toBe('widgets')
    expect(widgetEntry!.outputs).toContain('catalogEntry')
    expect(widgetEntry!.name).toBeUndefined()

    const gadgetEntry = snap.derivations['catalogEntry#1']
    expect(gadgetEntry).toBeDefined()
    expect(gadgetEntry!.source).toBe('gadgets')
    expect(gadgetEntry!.outputs).toContain('catalogEntry')
    expect(gadgetEntry!.name).toBeUndefined()
  })

  it('a NAMED derivation is keyed by its name even when it shares an output set with an unnamed one', async () => {
    const unnamedHandle = withDerivation({
      source: 'widgets',
      deterministic: true,
      outputs: { entry: { shape: 'record', collection: 'sharedOutput' } },
      derive: (s: Widget) => ({ entry: { id: s.id, kind: 'widget' } }),
      lifecycle: 'eager',
    })
    const namedHandle = withDerivation({
      name: 'gadget-to-shared',
      source: 'gadgets',
      deterministic: true,
      outputs: { entry: { shape: 'record', collection: 'sharedOutput' } },
      derive: (s: Gadget) => ({ entry: { id: s.id, kind: 'gadget' } }),
      lifecycle: 'eager',
    })

    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'pw',
      derivationStrategies: [unnamedHandle, namedHandle],
    })
    const vault = await db.openVault('acme')

    const snap = await vault.dumpSchema()

    expect(Object.keys(snap.derivations)).toHaveLength(2)

    const unnamedEntry = snap.derivations['sharedOutput']
    expect(unnamedEntry).toBeDefined()
    expect(unnamedEntry!.source).toBe('widgets')
    expect(unnamedEntry!.name).toBeUndefined()

    const namedEntry = snap.derivations['gadget-to-shared']
    expect(namedEntry).toBeDefined()
    expect(namedEntry!.source).toBe('gadgets')
    expect(namedEntry!.outputs).toContain('sharedOutput')
    expect(namedEntry!.name).toBe('gadget-to-shared')
  })

  it('a NAMED derivation whose name exactly matches an unnamed derivation\'s fallback key does not clobber it (#973)', async () => {
    const unnamedHandle = withDerivation({
      source: 'widgets',
      deterministic: true,
      outputs: { entry: { shape: 'record', collection: 'catalogEntry' } },
      derive: (s: Widget) => ({ entry: { id: s.id, kind: 'widget' } }),
      lifecycle: 'eager',
    })
    const namedHandle = withDerivation({
      name: 'catalogEntry',
      source: 'gadgets',
      deterministic: true,
      outputs: { entry: { shape: 'record', collection: 'catalogEntryNamed' } },
      derive: (s: Gadget) => ({ entry: { id: s.id, kind: 'gadget' } }),
      lifecycle: 'eager',
    })

    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'pw',
      derivationStrategies: [unnamedHandle, namedHandle],
    })
    const vault = await db.openVault('acme')

    const snap = await vault.dumpSchema()

    // Both must appear — today the named derivation silently overwrites the
    // unnamed one's entry because both key as 'catalogEntry'.
    expect(Object.keys(snap.derivations)).toHaveLength(2)

    const namedEntry = snap.derivations['catalogEntry']
    expect(namedEntry).toBeDefined()
    expect(namedEntry!.source).toBe('gadgets')
    expect(namedEntry!.name).toBe('catalogEntry')

    const unnamedEntry = snap.derivations['catalogEntry#1']
    expect(unnamedEntry).toBeDefined()
    expect(unnamedEntry!.source).toBe('widgets')
    expect(unnamedEntry!.name).toBeUndefined()

    // Consistency with listBehaviors() — same two names, no duplicate.
    const behaviorNames = vault.listBehaviors().derivations.map((d) => d.name)
    expect(new Set(behaviorNames).size).toBe(2)
    expect(behaviorNames.sort()).toEqual(['catalogEntry', 'catalogEntry#1'])
  })
})
