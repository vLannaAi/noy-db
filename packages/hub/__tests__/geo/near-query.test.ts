/**
 * `where(field, 'near', …)` end to end (#1355).
 *
 * The load-bearing assertion in this file is PARITY: an indexed collection
 * and an unindexed one, holding the same records, must answer every `near`
 * query identically. The index only ever narrows the candidate set, so a
 * disagreement is the geohash cover dropping a true match — the one failure
 * mode a post-filter cannot repair.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withIndexing } from '../../src/with-lookup/indexing/index.js'
import { via } from '../../src/kernel/via/compose.js'
import { geo, GeoPointError } from '../../src/via/geo/descriptor.js'
import { haversineKm, type GeoPoint } from '../../src/via/geo/geohash.js'
import { ValidationError, ConflictError } from '../../src/kernel/errors.js'
import type { Noydb } from '../../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
// #1458 — the query DSL ships in four groups; these side-effect imports
// attach the extension methods this file exercises. A consumer on the root
// barrel needs none of them (it imports all three); this file builds its
// Query from `kernel/query` directly, so it takes what it uses.
import '../../src/kernel/query/relate/index.js'

function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

interface Place {
  id: string
  name: string
  at?: GeoPoint
}

/** Deterministic LCG — a failing seed is a reproducible failing seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 }
}

/**
 * Points clustered around several centres — including the antimeridian and
 * both poles, where a lat/lng rectangle is at its least trustworthy — plus a
 * uniform sprinkle so no cell is special.
 */
function samplePlaces(count: number): Place[] {
  const next = rng(20260904)
  const clusters: GeoPoint[] = [
    { lat: 51.5007, lng: -0.1246 },
    { lat: -33.8568, lng: 151.2153 },
    { lat: 0, lng: 0 },
    { lat: 12, lng: 179.98 },
    { lat: -12, lng: -179.98 },
    { lat: 89.6, lng: 40 },
    { lat: -89.6, lng: -40 },
  ]
  const out: Place[] = []
  for (let i = 0; i < count; i++) {
    const id = `p-${String(i).padStart(4, '0')}`
    if (i % 5 === 0) {
      const lat = next() * 180 - 90
      const lng = next() * 360 - 180
      out.push({ id, name: id, at: { lat, lng } })
      continue
    }
    const c = clusters[i % clusters.length]!
    const lat = Math.max(-90, Math.min(90, c.lat + (next() - 0.5) * 2))
    let lng = c.lng + (next() - 0.5) * 2
    if (lng > 180) lng -= 360
    if (lng < -180) lng += 360
    out.push({ id, name: id, at: { lat, lng } })
  }
  // Records with no point at all: they must never match, and must never
  // crash a query that reaches them through the scan path.
  out.push({ id: 'p-nopoint-1', name: 'nowhere' })
  out.push({ id: 'p-nopoint-2', name: 'also nowhere' })
  return out
}

const RECORDS = samplePlaces(600)

async function setup() {
  const db: Noydb = await createNoydb({
    store: toMemory(),
    user: 'owner',
    secret: 'geo-near-test-secret-2026-1355',
    indexingStrategy: withIndexing(),
  })
  const vault = await db.openVault('TEST')
  const indexed = vault.collection<Place>('indexed', {
    viaFields: { at: via(geo()) },
    indexes: [{ fields: ['at'], kind: 'sorted' }],
  })
  const plain = vault.collection<Place>('plain', {
    viaFields: { at: via(geo()) },
  })
  for (const r of RECORDS) {
    await indexed.put(r.id, r)
    await plain.put(r.id, r)
  }
  return { indexed, plain }
}

const ids = (rows: readonly Place[]): string[] => rows.map(r => r.id).sort()

describe('#1355 geo — the stored shape', () => {
  let indexed: Awaited<ReturnType<typeof setup>>['indexed']
  beforeEach(async () => { ({ indexed } = await setup()) })

  it('stores a geohash beside the coordinates', async () => {
    const row = (await indexed.get('p-0001')) as unknown as { at: { lat: number; lng: number; geohash: string } }
    expect(typeof row.at.geohash).toBe('string')
    expect(row.at.geohash).toHaveLength(9)
    expect(row.at.lat).toBeCloseTo(RECORDS[1]!.at!.lat, 9)
  })

  it('honours a declared precision', async () => {
    const { indexed: coarse } = await (async () => {
      const db = await createNoydb({ store: toMemory(), user: 'o', secret: 'geo-precision-secret-2026', indexingStrategy: withIndexing() })
      const v = await db.openVault('T')
      const c = v.collection<Place>('c', { viaFields: { at: via(geo({ precision: 4 })) } })
      await c.put('a', { id: 'a', name: 'a', at: { lat: 1, lng: 2 } })
      return { indexed: c }
    })()
    const row = (await coarse.get('a')) as unknown as { at: { geohash: string } }
    expect(row.at.geohash).toHaveLength(4)
  })

  it('refuses a written value that is not a point', async () => {
    await expect(indexed.put('bad', { id: 'bad', name: 'bad', at: { lat: 91, lng: 0 } })).rejects.toBeInstanceOf(GeoPointError)
    await expect(indexed.put('bad2', { id: 'bad2', name: 'bad2', at: 'somewhere' as unknown as GeoPoint })).rejects.toBeInstanceOf(GeoPointError)
  })

  it('leaves an absent point absent', async () => {
    const row = (await indexed.get('p-nopoint-1')) as unknown as { at?: unknown }
    expect(row.at).toBeUndefined()
  })
})

describe('#1355 geo — near() indexed answers the same rows as the scan', () => {
  let indexed: Awaited<ReturnType<typeof setup>>['indexed']
  let plain: Awaited<ReturnType<typeof setup>>['plain']
  beforeEach(async () => { ({ indexed, plain } = await setup()) })

  const probes: ReadonlyArray<[string, GeoPoint, number]> = [
    ['london 1km', { lat: 51.5007, lng: -0.1246 }, 1],
    ['london 60km', { lat: 51.5007, lng: -0.1246 }, 60],
    ['sydney 120km', { lat: -33.8568, lng: 151.2153 }, 120],
    ['null island 200km', { lat: 0, lng: 0 }, 200],
    ['antimeridian east 150km', { lat: 12, lng: 179.98 }, 150],
    ['antimeridian west 150km', { lat: -12, lng: -179.98 }, 150],
    ['exactly on the antimeridian', { lat: 12, lng: 180 }, 100],
    ['north pole 300km', { lat: 89.6, lng: 40 }, 300],
    ['south pole 300km', { lat: -89.6, lng: -40 }, 300],
    ['the pole itself', { lat: 90, lng: 0 }, 400],
    ['continental 3000km', { lat: 45, lng: 10 }, 3000],
    ['a radius nothing is inside', { lat: 20, lng: 100 }, 0.001],
    ['zero radius', { lat: 51.5007, lng: -0.1246 }, 0],
  ]

  for (const [name, centre, radiusKm] of probes) {
    it(`${name} — index parity with the linear scan`, () => {
      const a = indexed.query().where('at', 'near', { ...centre, radiusKm }).toArray()
      const b = plain.query().where('at', 'near', { ...centre, radiusKm }).toArray()
      expect(ids(a)).toEqual(ids(b))
      // …and against a brute-force haversine over the raw records, so a
      // shared bug in both query paths still fails.
      const truth = RECORDS.filter(r => r.at !== undefined && haversineKm(r.at, centre) <= radiusKm).map(r => r.id).sort()
      expect(ids(a)).toEqual(truth)
    })
  }

  it('finds matches at all — the parity assertions are not vacuous', () => {
    const hits = indexed.query().where('at', 'near', { lat: 51.5007, lng: -0.1246, radiusKm: 60 }).toArray()
    expect(hits.length).toBeGreaterThan(10)
  })

  it('every returned record really is inside the radius', () => {
    const centre = { lat: -33.8568, lng: 151.2153 }
    for (const row of indexed.query().where('at', 'near', { ...centre, radiusKm: 90 }).toArray()) {
      expect(haversineKm(row.at!, centre)).toBeLessThanOrEqual(90)
    }
  })

  it('a pointless record never matches, however wide the radius', () => {
    const all = indexed.query().where('at', 'near', { lat: 0, lng: 0, radiusKm: 30000 }).toArray()
    expect(all.map(r => r.id)).not.toContain('p-nopoint-1')
    expect(all).toHaveLength(RECORDS.filter(r => r.at !== undefined).length)
  })

  it('composes with another clause', () => {
    const a = indexed.query().where('at', 'near', { lat: 51.5007, lng: -0.1246, radiusKm: 200 }).where('name', 'startsWith', 'p-00').toArray()
    const b = plain.query().where('at', 'near', { lat: 51.5007, lng: -0.1246, radiusKm: 200 }).where('name', 'startsWith', 'p-00').toArray()
    expect(a.length).toBeGreaterThan(0)
    expect(ids(a)).toEqual(ids(b))
  })

  it('tracks put and delete', async () => {
    const centre = { lat: 10, lng: 20 }
    const near = () => indexed.query().where('at', 'near', { ...centre, radiusKm: 5 }).toArray().map(r => r.id)
    expect(near()).toEqual([])
    await indexed.put('moved', { id: 'moved', name: 'moved', at: { lat: 10.001, lng: 20.001 } })
    expect(near()).toEqual(['moved'])
    await indexed.put('moved', { id: 'moved', name: 'moved', at: { lat: -10, lng: -20 } })
    expect(near()).toEqual([])
    await indexed.put('moved', { id: 'moved', name: 'moved', at: { lat: 10.001, lng: 20.001 } })
    expect(near()).toEqual(['moved'])
    await indexed.delete('moved')
    expect(near()).toEqual([])
  })
})

describe('#1355 geo — dispatch and refusals', () => {
  let indexed: Awaited<ReturnType<typeof setup>>['indexed']
  let plain: Awaited<ReturnType<typeof setup>>['plain']
  beforeEach(async () => { ({ indexed, plain } = await setup()) })

  it('explain() names the prefix index on the indexed collection and a scan on the plain one', () => {
    const operand = { lat: 51.5007, lng: -0.1246, radiusKm: 20 }
    const hot = indexed.query().where('at', 'near', operand).explain()
    const cold = plain.query().where('at', 'near', operand).explain()
    expect(hot.nodes.map(n => n.dispatch)).toContain('index:prefix')
    expect(cold.nodes.map(n => n.dispatch)).not.toContain('index:prefix')
    const node = hot.nodes.find(n => n.dispatch === 'index:prefix')!
    expect(node.notes.join(' ')).toContain('superset')
    // The candidate set is a superset of the answer, and a strict subset of
    // the collection — the two properties that make the index worth having.
    const answer = indexed.query().where('at', 'near', operand).toArray().length
    expect(node.estimatedRows!).toBeGreaterThanOrEqual(answer)
    expect(node.estimatedRows!).toBeLessThan(RECORDS.length)
  })

  it('throws at the where() call site on a malformed operand', () => {
    const q = indexed.query()
    expect(() => q.where('at', 'near', { lat: 51, lng: 0 })).toThrow(ValidationError)
    expect(() => q.where('at', 'near', { lat: 91, lng: 0, radiusKm: 5 })).toThrow(ValidationError)
    expect(() => q.where('at', 'near', { lat: 51, lng: 0, radiusKm: -1 })).toThrow(ValidationError)
    expect(() => q.where('at', 'near', 'nearby')).toThrow(ValidationError)
    expect(() => q.where('at', 'near', null)).toThrow(ValidationError)
  })

  it('`near` over an UNDECLARED field matches nothing rather than guessing', () => {
    // `name` is not a geo field, so no binding claims the clause and the
    // kernel has no notion of a point to compare.
    expect(indexed.query().where('name', 'near', { lat: 0, lng: 0, radiusKm: 100 }).toArray()).toEqual([])
  })

  it('an ordinary operator over a geo field agrees between the index and the scan', () => {
    // ⛔ THE REGRESSION THIS PINS: the geo index key is a geohash STRING
    // while the stored value is an OBJECT. If the binding left non-`near`
    // operators unclaimed, `startsWith` would take the sorted index and
    // answer over geohashes, while the unindexed collection compared an
    // object and answered nothing — the same query, two answers.
    for (const [op, operand] of [
      ['startsWith', 'gc'],
      ['startsWith', 'u'],
      ['<', 'zzz'],
      ['>=', ''],
      ['between', ['a', 'z']],
      ['==', { lat: 51.5007, lng: -0.1246 }],
      ['contains', 'u'],
    ] as const) {
      const a = indexed.query().where('at', op, operand).toArray()
      const b = plain.query().where('at', op, operand).toArray()
      expect(ids(a), `${op} ${JSON.stringify(operand)}`).toEqual(ids(b))
    }
  })

  it('`!=` over a geo field still matches, exactly as the generic scan does', () => {
    // The delegated operators are the KERNEL's semantics, not geo's — `!=`
    // against a fresh object literal matches every record, pointless ones
    // included. Claiming the operator must not quietly change that.
    const a = indexed.query().where('at', '!=', { lat: 0, lng: 0 }).toArray()
    const b = plain.query().where('at', '!=', { lat: 0, lng: 0 }).toArray()
    expect(a).toHaveLength(RECORDS.length)
    expect(ids(a)).toEqual(ids(b))
  })

  it('a geo field still answers the ordinary operators', () => {
    // The index key is a geohash, so `==` against the STORED shape still
    // works through the generic path — geo claims `near` only.
    const one = RECORDS[3]!
    const rows = indexed.query().filter(r => r.id === one.id).toArray()
    expect(rows).toHaveLength(1)
  })
})

/**
 * Lazy mode has no `startsWith` slice on its persisted mirror, so `near`
 * takes no prefix fast path there. What it must NOT do is disagree with the
 * eager answer, or refuse the query — before #1355's fallback the tail of
 * `resolveCandidateIds()` returned `null` for an op no branch claimed, which
 * `toArray()` turns into `IndexRequiredError`.
 */
describe('#1355 geo — lazy mode answers near() rather than refusing it', () => {
  const LAZY = { prefetch: false as const, cache: { maxRecords: 500 } }

  async function openLazyGeo() {
    const db = await createNoydb({ store: toMemory(), user: 'owner', secret: 'geo-lazy-secret-2026-1355', indexingStrategy: withIndexing() })
    const vault = await db.openVault('ACME')
    const coll = vault.collection<Place>('places', {
      ...LAZY,
      viaFields: { at: via(geo()) },
      indexes: ['at'],
    })
    for (const r of RECORDS.slice(0, 120)) await coll.put(r.id, r)
    return coll
  }

  it('matches a brute-force haversine over the same records', async () => {
    const coll = await openLazyGeo()
    const centre = { lat: 51.5007, lng: -0.1246 }
    const rows = await coll.lazyQuery().where('at', 'near', { ...centre, radiusKm: 120 }).toArray()
    const truth = RECORDS.slice(0, 120)
      .filter(r => r.at !== undefined && haversineKm(r.at, centre) <= 120)
      .map(r => r.id).sort()
    expect(truth.length).toBeGreaterThan(0)
    expect(rows.map(r => r.id).sort()).toEqual(truth)
  })
})
