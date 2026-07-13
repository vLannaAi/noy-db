// #553 — archetype-③ schema engines are lazy: the schema declaration is
// the opt-in unit, and the floor never links an engine a collection
// didn't declare.
//
// The bundle-level proof lives in scripts/check-bundle.mjs (the floor
// scenario's `eagerImports` canaries); this file proves the RUNTIME
// seams: (a) a floor collection with no declarations never installs the
// money engine, (b) every converted engine still behaves identically
// when its declaration is present.
//
// NOTE on ordering: the money Via binder installs into module-level state
// (kernel/via.ts's `binders` map) when `money()` is first called, so the
// "not installed" assertions run FIRST in this file (vitest runs a file's
// tests sequentially, and each test file gets its own module registry).

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/index.js'
import { money } from '../src/via/money/descriptor.js'
import { isViaInstalled, viaBinder } from '../src/kernel/via.js'
import { withAggregate } from '../src/with-lookup/aggregate/index.js'
import { sum } from '../src/with-lookup/aggregate/reducers.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

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
        const [vname, cname, id] = key.split('/') as [string, string, string]
        if (vname === v) { out[cname] = out[cname] ?? {}; out[cname][id] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) { data.set(k(v, c, i), payload[c]![i]!) }
      }
    },
  }
}

async function openTestVault() {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: 'lazy-engines-553-test-passphrase',
    aggregateStrategy: withAggregate(),
  })
  return db.openVault('main')
}

describe('#553 — floor collection without ③ declarations', () => {
  it('never installs the money engine (write/read/query all work without it)', async () => {
    // Nothing in this file has called money() yet — importing the barrel
    // alone must not link the engine.
    expect(isViaInstalled('money')).toBe(false)
    expect(() => viaBinder('money')).toThrowError(/money/)

    const vault = await openTestVault()
    const coll = vault.collection<Record<string, unknown>>('plain')
    await coll.put('a', { id: 'a', n: 2 })
    await coll.put('b', { id: 'b', n: 5 })
    expect(await coll.get('a')).toMatchObject({ n: 2 })
    const rows = coll.query().where('n', '>', 1).toArray()
    expect(rows).toHaveLength(2)
    await coll.delete('b')
    expect(await coll.get('b')).toBeNull()

    // The plain collection's whole lifecycle consulted no money engine.
    expect(isViaInstalled('money')).toBe(false)
  })
})

describe('#553 — engines still work when declared', () => {
  it('money: declaring via money() links the engine; quantize/where/sort/sum/decode intact', async () => {
    const vault = await openTestVault()
    const coll = vault.collection<Record<string, unknown>>('invoices', {
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    expect(isViaInstalled('money')).toBe(true)

    await coll.put('i1', { id: 'i1', total: '10.50' })
    await coll.put('i2', { id: 'i2', total: 3 })

    // Read decodes stored scaled-int back to exact decimal.
    expect(await coll.get('i1')).toMatchObject({ total: '10.50' })

    // SYNC query DSL: build-time operand quantization + BigInt-exact compare.
    const over5 = coll.query().where('total', '>', 5).toArray()
    expect(over5).toHaveLength(1)
    expect(over5[0]).toMatchObject({ id: 'i1' })

    // Malformed operand still throws AT .where() — sync error timing preserved.
    expect(() => coll.query().where('total', '>', 'not-a-number')).toThrowError()

    // Money-aware ordering (BigInt scaled compare).
    const sorted = coll.query().orderBy('total', 'asc').toArray()
    expect(sorted.map(r => r['id'])).toEqual(['i2', 'i1'])

    // Exact money sum via wrapped reducers.
    const agg = await coll.query().aggregate({ total: sum('total') }).run()
    expect(agg.total).toBe('13.50')
  })

  it('computed: engine loads on the first computed-declared put', async () => {
    const vault = await openTestVault()
    const coll = vault.collection<Record<string, unknown>>('orders', {
      computed: { gross: (r: Record<string, unknown>) => (r['net'] as number) * 2 },
    })
    await coll.put('o1', { id: 'o1', net: 21 })
    expect(await coll.get('o1')).toMatchObject({ gross: 42 })
  })

  it('links: lazy handle is cached, does I/O on demand, and cascades on delete', async () => {
    const vault = await openTestVault()
    const students = vault.collection<Record<string, unknown>>('students')
    const courses = vault.collection<Record<string, unknown>>('courses')
    await students.put('s1', { id: 's1' })
    await courses.put('c1', { id: 'c1' })

    vault.link('enrollment', { a: 'students', b: 'courses' })
    const handle = vault.links('enrollment')
    expect(vault.links('enrollment')).toBe(handle) // cached, same object

    await handle.connect('s1', 'c1', { grade: 'A' })
    expect(await handle.has('s1', 'c1')).toBe(true)
    expect(await handle.of('s1')).toEqual([{ a: 's1', b: 'c1', meta: { grade: 'A' } }])

    // Default onDelete: 'cascade' — deleting an endpoint removes its rows.
    await students.delete('s1')
    expect(await handle.list()).toEqual([])
  })

  it('schema-update: gated writes + fence state via the lazy engine', async () => {
    const { additiveOnly } = await import('../src/with-shape/schema-update/strategies.js')
    const vault = await openTestVault()
    const coll = vault.collection<Record<string, unknown>>('docs', {
      schema: z.object({ id: z.string(), title: z.string() }),
      persistJsonSchema: true,
      schemaUpdate: [additiveOnly()],
    })
    await coll.put('d1', { id: 'd1', title: 'hello' })
    expect(await coll.get('d1')).toMatchObject({ title: 'hello' })
    // Lazy loadFence path — a vault with no active cutover reads 'normal'.
    const fence = await vault.schemaFenceState()
    expect(fence.fenceState).toBe('normal')
  })

  it('introspection: dumpSchema and toJSONSchema resolve via lazy imports', async () => {
    const vault = await openTestVault()
    const coll = vault.collection<Record<string, unknown>>('items', {
      schema: z.object({ id: z.string(), qty: z.number() }),
    })
    await coll.put('x', { id: 'x', qty: 1 })

    const snapshot = await vault.dumpSchema()
    expect(Object.keys(snapshot.collections)).toContain('items')

    const js = await coll.toJSONSchema() as Record<string, unknown>
    expect(js).toBeTruthy()
    expect(typeof js).toBe('object')

    // Sync describe() is unchanged (stays static — public sync API).
    const desc = coll.describe()
    expect(desc.collection).toBe('items')
  })
})
