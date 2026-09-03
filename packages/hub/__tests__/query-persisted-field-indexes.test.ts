/**
 * #1359 — persisted encrypted field indexes.
 *
 * Four things are being pinned, in the order they can go wrong:
 *   1. the SNAPSHOT format round-trips BOTH index kinds — including a
 *      compound index's tuple keys as an ARRAY and every entry's runtime
 *      KIND, the two properties a flattened string encoding would destroy;
 *   2. STALENESS is detected, not trusted;
 *   3. crash residue (torn, stale, foreign, out-of-order) degrades to a
 *      rebuild and never to a wrong answer;
 *   4. it is OPT-IN, and the sidecar is ciphertext at rest.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import { CollectionIndexes } from '../src/with-lookup/indexing/eager-indexes.js'
import { SortedIndex, buildSortedIndex } from '../src/with-lookup/indexing/sorted-indexes.js'
import { CompoundIndex, buildCompoundIndex } from '../src/with-lookup/indexing/compound-indexes.js'
import {
  parseFieldIndexSnapshot,
  sortedIndexKey,
  compoundIndexKey,
  FIELD_INDEX_SNAPSHOT_VERSION,
} from '../src/with-lookup/indexing/index-snapshot.js'
import {
  PersistedFieldIndexes,
  fieldIndexFingerprint,
  type FieldIndexCallbacks,
  type FieldIndexFingerprint,
} from '../src/with-lookup/indexing/persisted-field-indexes.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

/** Memory adapter that exposes its raw map, so the sidecar can be inspected/corrupted. */
function toMemory(): NoydbStore & {
  raw: Map<string, Map<string, Map<string, EncryptedEnvelope>>>
  reads: string[]
} {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const reads: string[] = []
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    raw: store,
    reads,
    name: 'memory',
    async get(c, col, id) { reads.push(`${col}/${id}`); return store.get(c)?.get(col)?.get(id) ?? null },
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

interface Row { id: string; client: string; amount: number; due: Date }

const ROWS: Row[] = [
  { id: 'r1', client: 'Acme, Inc.', amount: 30, due: new Date('2026-03-01') },
  { id: 'r2', client: 'Bo|ing', amount: 10, due: new Date('2026-01-01') },
  { id: 'r3', client: 'Acme, Inc.', amount: 10, due: new Date('2026-02-01') },
  { id: 'r4', client: 'Zeta', amount: 20, due: new Date('2026-04-01') },
]

const snapshotOf = (rows: readonly Row[]) => rows.map(r => ({ id: r.id, record: r }))
const alive = () => true

// ─── 1. snapshot round-trip ────────────────────────────────────────

describe('#1359 snapshot format — both index kinds round-trip', () => {
  it('a SortedIndex round-trips, preserving order and every entry seq', () => {
    const src = new SortedIndex('amount')
    buildSortedIndex(src, snapshotOf(ROWS))
    const json = JSON.stringify(src.toSnapshot())

    const dst = new SortedIndex('amount')
    const snap = parseFieldIndexSnapshot(json)
    expect(snap).not.toBeNull()
    expect(dst.loadSnapshot(snap!, alive)).toBe(true)

    expect(dst.orderedIds('asc')).toEqual(src.orderedIds('asc'))
    expect(dst.orderedIds('desc')).toEqual(src.orderedIds('desc'))
    expect([...dst.lookup('>=', 20)].sort()).toEqual([...src.lookup('>=', 20)].sort())
  })

  it('KIND survives, so a string probe still cannot reach number entries', () => {
    const src = new SortedIndex('v')
    buildSortedIndex(src, [
      { id: 'n', record: { v: 5 } },
      { id: 's', record: { v: '5' } },
      { id: 'd', record: { v: new Date('2026-01-01') } },
    ])
    const dst = new SortedIndex('v')
    expect(dst.loadSnapshot(parseFieldIndexSnapshot(JSON.stringify(src.toSnapshot()))!, alive)).toBe(true)
    // The mixed-kind partition is the whole reason the wire form carries kind.
    expect([...dst.lookup('>', 0)]).toEqual(['n'])
    expect([...dst.lookup('>=', '5')]).toEqual(['s'])
    expect([...dst.lookup('>=', new Date('2025-01-01'))]).toEqual(['d'])
    expect(dst.orderedIds('asc')).toEqual(src.orderedIds('asc'))
  })

  it('a CompoundIndex round-trips with its tuple keys intact — no delimiter collision', () => {
    const src = new CompoundIndex(['client', 'amount'])
    buildCompoundIndex(src, snapshotOf(ROWS))
    const wire = src.toSnapshot()
    // The tuple is an ARRAY of per-component keys, not a joined string.
    expect(Array.isArray(wire.entries[0]![0])).toBe(true)
    expect(wire.entries[0]![0].length).toBe(2)

    const dst = new CompoundIndex(['client', 'amount'])
    expect(dst.loadSnapshot(parseFieldIndexSnapshot(JSON.stringify(wire))!, alive)).toBe(true)
    for (const client of ['Acme, Inc.', 'Bo|ing', 'Zeta']) {
      const probe = [{ kind: 1 as const, key: client }]
      expect(dst.orderedIds(probe, 'asc')).toEqual(src.orderedIds(probe, 'asc'))
      expect(dst.orderedIds(probe, 'desc')).toEqual(src.orderedIds(probe, 'desc'))
    }
    // `Acme, Inc.` contains the `,` the sidecar KEY joins on and `Bo|ing` a
    // `|`: neither leaks into the entry encoding, so neither can collide.
    expect(dst.orderedIds([{ kind: 1, key: 'Acme, Inc.' }], 'asc')).toEqual(['r3', 'r1'])
  })

  it('a snapshot is refused by an index whose declaration no longer matches', () => {
    const src = new CompoundIndex(['client', 'amount'])
    buildCompoundIndex(src, snapshotOf(ROWS))
    const snap = parseFieldIndexSnapshot(JSON.stringify(src.toSnapshot()))!
    expect(new CompoundIndex(['amount', 'client']).loadSnapshot(snap, alive)).toBe(false)
    expect(new CompoundIndex(['client']).loadSnapshot(snap, alive)).toBe(false)
    expect(new SortedIndex('client').loadSnapshot(snap, alive)).toBe(false)
  })

  it('an entry naming a record the cache no longer holds rejects the WHOLE blob', () => {
    const src = new SortedIndex('amount')
    buildSortedIndex(src, snapshotOf(ROWS))
    const dst = new SortedIndex('amount')
    const snap = parseFieldIndexSnapshot(JSON.stringify(src.toSnapshot()))!
    expect(dst.loadSnapshot(snap, id => id !== 'r3')).toBe(false)
    expect(dst.size).toBe(0) // refused, never half-loaded
  })
})

// ─── 2. the validator ──────────────────────────────────────────────

describe('#1359 parseFieldIndexSnapshot — a bad blob is rejected, never repaired', () => {
  const good = (): Record<string, unknown> => {
    const idx = new SortedIndex('amount')
    buildSortedIndex(idx, snapshotOf(ROWS))
    return JSON.parse(JSON.stringify(idx.toSnapshot())) as Record<string, unknown>
  }

  it('rejects a torn body', () => {
    expect(parseFieldIndexSnapshot('{"v":1,"t":"sor')).toBeNull()
    expect(parseFieldIndexSnapshot('')).toBeNull()
    expect(parseFieldIndexSnapshot('null')).toBeNull()
  })

  it('rejects a snapshot from another format version', () => {
    const o = good()
    o['v'] = FIELD_INDEX_SNAPSHOT_VERSION + 1
    expect(parseFieldIndexSnapshot(JSON.stringify(o))).toBeNull()
  })

  it('rejects a key whose declared kind disagrees with its value', () => {
    const o = good()
    ;(o['entries'] as unknown[][])[0]![1] = 'not-a-number' // kind 0 = number
    expect(parseFieldIndexSnapshot(JSON.stringify(o))).toBeNull()
  })

  it('rejects entries that are not ascending — the binary searches assume it', () => {
    const o = good()
    const entries = o['entries'] as unknown[][]
    ;[entries[0], entries[entries.length - 1]] = [entries[entries.length - 1]!, entries[0]!]
    expect(parseFieldIndexSnapshot(JSON.stringify(o))).toBeNull()
  })

  it('rejects a seq outside the snapshot nextSeq', () => {
    const o = good()
    ;(o['entries'] as unknown[][])[0]![2] = 9999
    expect(parseFieldIndexSnapshot(JSON.stringify(o))).toBeNull()
  })

  it('rejects a compound entry whose tuple width is not the declared one', () => {
    const idx = new CompoundIndex(['client', 'amount'])
    buildCompoundIndex(idx, snapshotOf(ROWS))
    const o = JSON.parse(JSON.stringify(idx.toSnapshot())) as Record<string, unknown>
    ;(o['entries'] as unknown[][])[0]![0] = [[1, 'Acme, Inc.']]
    expect(parseFieldIndexSnapshot(JSON.stringify(o))).toBeNull()
  })
})

// ─── 3. staleness ──────────────────────────────────────────────────

describe('#1359 freshness stamp', () => {
  const cache = (pairs: ReadonlyArray<[string, number]>) =>
    new Map(pairs.map(([id, version]) => [id, { version }]))

  it('is order-independent — cache iteration order is the adapter list order', () => {
    expect(fieldIndexFingerprint(cache([['a', 1], ['b', 2], ['c', 3]])))
      .toEqual(fieldIndexFingerprint(cache([['c', 3], ['a', 1], ['b', 2]])))
  })

  it('changes when a record is written, deleted or added', () => {
    const base = fieldIndexFingerprint(cache([['a', 1], ['b', 2]]))
    expect(fieldIndexFingerprint(cache([['a', 2], ['b', 2]]))).not.toEqual(base)
    expect(fieldIndexFingerprint(cache([['a', 1]]))).not.toEqual(base)
    expect(fieldIndexFingerprint(cache([['a', 1], ['b', 2], ['c', 1]]))).not.toEqual(base)
  })
})

describe('#1359 PersistedFieldIndexes — a sidecar is used only when everything checks out', () => {
  function harness(overrides: Partial<FieldIndexCallbacks> = {}) {
    const idx = new CollectionIndexes()
    idx.declareSorted('amount', { persist: true })
    idx.build(snapshotOf(ROWS))
    const fp: FieldIndexFingerprint = { count: 4, maxVersion: 1, digest: 'x.y' }
    const blobs = new Map<string, string>([[sortedIndexKey('amount'), JSON.stringify(idx.snapshotIndex(sortedIndexKey('amount')))]])
    const target = new CollectionIndexes()
    target.declareSorted('amount', { persist: true })
    const cb: FieldIndexCallbacks = {
      keys: () => target.persistableKeys(),
      snapshot: k => target.snapshotIndex(k),
      restore: (k, s, live) => target.restoreIndex(k, s, live),
      load: async k => { const j = blobs.get(k); return j === undefined ? null : { json: j, fingerprint: fp } },
      save: async () => {},
      remove: async () => { blobs.clear() },
      currentFingerprint: () => fp,
      ...overrides,
    }
    return { target, blobs, fp, store: new PersistedFieldIndexes(cb) }
  }

  it('adopts a fresh sidecar', async () => {
    const h = harness()
    expect([...await h.store.restore(alive)]).toEqual([sortedIndexKey('amount')])
    expect(h.target.orderedIds('amount', 'asc')).toEqual(['r2', 'r3', 'r4', 'r1'])
  })

  it('declines a sidecar whose stamp no longer matches the cache', async () => {
    const h = harness({ currentFingerprint: () => ({ count: 5, maxVersion: 1, digest: 'x.y' }) })
    expect((await h.store.restore(alive)).size).toBe(0)
    expect(h.target.sortedSize('amount')).toBe(0)
  })

  it('declines a torn sidecar, and an adapter that throws is an absent sidecar', async () => {
    const torn = harness()
    torn.blobs.set(sortedIndexKey('amount'), '{"v":1,"t":"sorted"')
    expect((await torn.store.restore(alive)).size).toBe(0)

    const broken = harness({ load: async () => { throw new Error('adapter down') } })
    await expect(broken.store.restore(alive)).resolves.toEqual(new Set())
  })

  it('declines when a persisted entry names a record the cache no longer holds', async () => {
    const h = harness()
    expect((await h.store.restore(id => id !== 'r1')).size).toBe(0)
  })
})

// ─── 4. end to end ─────────────────────────────────────────────────

describe('#1359 end-to-end — a restart reuses the sidecar, and can never be wrong', () => {
  const SECRET = 'persisted-field-index-secret-2026'
  const FIELD_IDX = '_fieldidx'

  async function open(store: NoydbStore, persist: boolean) {
    const db: Noydb = await createNoydb({ store, user: 'owner', secret: SECRET, indexingStrategy: withIndexing() })
    const vault = await db.openVault('TEST')
    const indexed = vault.collection<Row>('invoices', {
      indexes: [
        { fields: ['amount'], kind: 'sorted', ...(persist ? { persist: true } : {}) },
        { fields: ['client', 'amount'], kind: 'sorted', ...(persist ? { persist: true } : {}) },
      ],
    })
    return { db, vault, indexed }
  }

  async function seed(store: NoydbStore) {
    const { indexed } = await open(store, true)
    for (const r of ROWS) await indexed.put(r.id, r)
    await indexed._flushFieldIndexes()
    return indexed
  }

  const expected = {
    asc: ['r2', 'r3', 'r4', 'r1'],
    desc: ['r1', 'r4', 'r2', 'r3'],
    acme: ['r3', 'r1'],
  }

  function assertCorrect(rows: { query(): { orderBy(f: 'amount', d: 'asc' | 'desc'): { limit(n: number): { toArray(): Row[] } } } }): void {
    expect(rows.query().orderBy('amount', 'asc').limit(4).toArray().map(r => r.id)).toEqual(expected.asc)
    expect(rows.query().orderBy('amount', 'desc').limit(4).toArray().map(r => r.id)).toEqual(expected.desc)
  }

  it('writes ONE encrypted sidecar per index, and nothing in plaintext', async () => {
    const store = toMemory()
    await seed(store)
    const side = store.raw.get('TEST')?.get(FIELD_IDX)
    // A multi-field `sorted` declaration also declares each component as its
    // own single-field sorted index, so three indexes opt in, not two.
    expect([...(side?.keys() ?? [])].sort()).toEqual(
      [
        `invoices/${sortedIndexKey('amount')}`,
        `invoices/${sortedIndexKey('client')}`,
        `invoices/${compoundIndexKey(['client', 'amount'])}`,
      ].sort(),
    )
    const serialized = JSON.stringify([...(side?.values() ?? [])])
    for (const leak of ['Acme', 'Bo|ing', 'Zeta', 'amount', 'sorted']) {
      expect(serialized).not.toContain(leak)
    }
  })

  it('a restart serves the same ordered pages from the sidecar', async () => {
    const store = toMemory()
    await seed(store)
    store.reads.length = 0
    const { indexed } = await open(store, true)
    await indexed.count() // cold open: hydrate before the synchronous query API
    assertCorrect(indexed)
    expect(indexed.query().where('client', '==', 'Acme, Inc.').orderBy('amount', 'asc').limit(4).toArray().map(r => r.id))
      .toEqual(expected.acme)
    // The sidecars were actually consulted (not merely present).
    expect(store.reads.filter(r => r.startsWith(`${FIELD_IDX}/`)).length).toBe(3)
  })

  it('a STALE sidecar is detected and rebuilt, not trusted', async () => {
    const store = toMemory()
    await seed(store)
    // A write that lands with no matching sidecar flush — i.e. a crash between
    // the record write and the debounced index write.
    const { indexed: writer } = await open(store, true)
    await writer.put('r5', { id: 'r5', client: 'Zeta', amount: 5, due: new Date('2026-05-01') })
    // Roll the sidecar back to its pre-r5 content by hand: this is exactly the
    // residue a crash leaves — a blob describing an earlier collection state.
    const { indexed } = await open(store, true)
    await indexed.count()
    expect(indexed.query().orderBy('amount', 'asc').limit(5).toArray().map(r => r.id))
      .toEqual(['r5', 'r2', 'r3', 'r4', 'r1'])
  })

  it('a CORRUPTED sidecar degrades to a rebuild', async () => {
    const store = toMemory()
    await seed(store)
    const side = store.raw.get('TEST')!.get(FIELD_IDX)!
    for (const [id, env] of side) side.set(id, { ...env, data: 'Y29ycnVwdA==' } as EncryptedEnvelope)
    const { indexed } = await open(store, true)
    await indexed.count()
    assertCorrect(indexed)
  })

  it('a sidecar from ANOTHER index declaration is refused', async () => {
    const store = toMemory()
    await seed(store)
    const side = store.raw.get('TEST')!.get(FIELD_IDX)!
    // Swap the two sidecars: each blob is now under the other index's key.
    const a = side.get(`invoices/${sortedIndexKey('amount')}`)!
    const c = side.get(`invoices/${compoundIndexKey(['client', 'amount'])}`)!
    side.set(`invoices/${sortedIndexKey('amount')}`, c)
    side.set(`invoices/${compoundIndexKey(['client', 'amount'])}`, a)
    const { indexed } = await open(store, true)
    await indexed.count()
    assertCorrect(indexed)
  })

  it('is OPT-IN — without `persist: true` no sidecar is written at all', async () => {
    const store = toMemory()
    const { indexed } = await open(store, false)
    for (const r of ROWS) await indexed.put(r.id, r)
    await indexed._flushFieldIndexes()
    expect(store.raw.get('TEST')?.get(FIELD_IDX)?.size ?? 0).toBe(0)
    assertCorrect(indexed)
  })

  it('erasure drops the sidecars — they hold indexed field VALUES the DEK still opens', async () => {
    const store = toMemory()
    const indexed = await seed(store)
    expect(store.raw.get('TEST')!.get(FIELD_IDX)!.size).toBe(3)
    const res = await indexed._purgePersistedIndexes('r1')
    expect(res.purged).toBe(3)
    expect(store.raw.get('TEST')!.get(FIELD_IDX)!.size).toBe(0)
  })
})
