import { describe, it, expect } from 'vitest'
import { createNoydb, withRollup } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, Sealed } from '../src/types.js'
import { ConflictError } from '../src/index.js'

interface Person {
  id: string
  name: string
  ssn?: string
  dob?: string
}

function memoryStore(): NoydbStore & { _data: Map<string, Map<string, Map<string, EncryptedEnvelope>>> } {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    _data: data,
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, snap) {
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      data.set(v, vm)
    },
  }
}

function isSealed(v: unknown): v is Sealed<unknown> {
  return typeof v === 'object' && v !== null && (v as { sealed?: unknown }).sealed === true
    && typeof (v as { reveal?: unknown }).reveal === 'function'
}

const SSN = '123-45-6789'

describe('Sealed<V> access gate — public reads return handles', () => {
  it('get() returns a Sealed handle for a sensitive field, plain value otherwise', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    const people = v.collection<Person>('people', { sensitive: ['ssn'] })

    await people.put('p1', { id: 'p1', name: 'Alice', ssn: SSN })

    const r = await people.get('p1')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('Alice')
    expect(isSealed(r!.ssn)).toBe(true)
    expect((r!.ssn as Sealed<string>).sealed).toBe(true)
    // reveal() decrypts on demand
    expect(await (r!.ssn as Sealed<string>).reveal()).toBe(SSN)
  })

  it('Sealed handle does NOT leak the plaintext through JSON or logging', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    const people = v.collection<Person>('people', { sensitive: ['ssn'] })

    await people.put('p1', { id: 'p1', name: 'Alice', ssn: SSN })
    const r = await people.get('p1')

    const json = JSON.stringify(r)
    expect(json).not.toContain(SSN)
    expect(json).toContain('[sealed]')

    // structured logging via util.inspect (what console.log uses) must not leak
    const { inspect } = await import('node:util')
    expect(inspect(r, { depth: 5 })).not.toContain(SSN)
  })

  it('non-residency: the working-set cache holds a handle, never the plaintext', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    const people = v.collection<Person>('people', { sensitive: ['ssn'] })

    await people.put('p1', { id: 'p1', name: 'Alice', ssn: SSN })
    // fresh read populates / serves from the cache
    await people.get('p1')

    // @internal peek at the eager cache
    const cache = (people as unknown as { cache: Map<string, { record: Person }> }).cache
    const cached = cache.get('p1')
    expect(cached).toBeDefined()
    expect(isSealed(cached!.record.ssn)).toBe(true)
    expect(JSON.stringify(cached!.record)).not.toContain(SSN)
    // and the handle still reveals the real value
    expect(await (cached!.record.ssn as unknown as Sealed<string>).reveal()).toBe(SSN)
  })

  it('query() / scan() / first() / toArray() return handles for sensitive fields', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    const people = v.collection<Person>('people', { sensitive: ['ssn'] })

    await people.put('p1', { id: 'p1', name: 'Alice', ssn: SSN })
    await people.put('p2', { id: 'p2', name: 'Bob', ssn: '999-88-7777' })

    const all = await people.query().toArray()
    expect(all.length).toBe(2)
    for (const rec of all) {
      expect(isSealed((rec as Person).ssn)).toBe(true)
      expect(JSON.stringify(rec)).not.toContain(SSN)
    }

    const first = await people.query().where('name', '==', 'Alice').first()
    expect(first).not.toBeNull()
    expect(isSealed((first as Person).ssn)).toBe(true)
    expect(await ((first as Person).ssn as unknown as Sealed<string>).reveal()).toBe(SSN)

    // scan() over the full collection
    const scanned: Person[] = []
    for await (const rec of people.scan()) scanned.push(rec as Person)
    expect(scanned.length).toBe(2)
    for (const rec of scanned) expect(isSealed(rec.ssn)).toBe(true)
  })

  it('multiple sensitive fields each become independent handles', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    const people = v.collection<Person>('people', { sensitive: ['ssn', 'dob'] })

    await people.put('p1', { id: 'p1', name: 'Alice', ssn: SSN, dob: '1990-01-01' })
    const r = await people.get('p1')
    expect(isSealed(r!.ssn)).toBe(true)
    expect(isSealed(r!.dob)).toBe(true)
    expect(await (r!.ssn as Sealed<string>).reveal()).toBe(SSN)
    expect(await (r!.dob as Sealed<string>).reveal()).toBe('1990-01-01')
  })

  it('default-off: no sensitive option → plain values, no handles', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    const people = v.collection<Person>('people')

    await people.put('p1', { id: 'p1', name: 'Alice', ssn: SSN })
    const r = await people.get('p1')
    expect(r!.ssn).toBe(SSN)
    expect(isSealed(r!.ssn)).toBe(false)

    const cache = (people as unknown as { cache: Map<string, { record: Person }> }).cache
    expect(cache.get('p1')!.record.ssn).toBe(SSN)
  })
})

// Regression: lazy cache mode + sealed `sensitive` field + a rollup derivation
// that patches the parent. `recomputeRollup` uses `_getStoredRecord` as the
// patch base; pre-fix the lazy branch returned the cached Sealed handle (which
// re-encrypts to the marker '[sealed]' → corruption) on a HIT, and stored raw
// plaintext into the LRU on a MISS (non-residency leak). See
// `Collection._getStoredRecord`.
interface Buyer extends Record<string, unknown> { id: string; companyName: string; ssn?: string; totalSpent?: number }
interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }

describe('Sealed<V> gate — lazy cache + sealed field + rollup derivation (regression)', () => {
  async function setup() {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      derivationStrategies: [
        withRollup<Sale, Buyer>({
          from: 'sales', key: 'buyerId', into: 'buyers',
          field: 'totalSpent', compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
        }),
      ],
    })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    // Parent is LAZY (prefetch:false + bounded cache) AND seals `ssn`.
    const buyers = v.collection<Buyer>('buyers', {
      sensitive: ['ssn'], prefetch: false, cache: { maxRecords: 16 },
    })
    const sales = v.collection<Sale>('sales')
    return { buyers, sales }
  }

  it('keeps the sealed field intact across a rollup patch + restores the gate invariants', async () => {
    const { buyers, sales } = await setup()
    await buyers.put('b1', { id: 'b1', companyName: 'Acme', ssn: SSN })

    // Child write triggers recomputeRollup → patches buyers.b1 via _getStoredRecord.
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 250 })

    // (1) The rollup field is maintained AND the sealed field's real value is
    //     intact (NOT '[sealed]') — round-trips via reveal().
    const r = await buyers.get('b1')
    expect(r!.totalSpent).toBe(350)
    expect(isSealed(r!.ssn)).toBe(true)
    expect(await (r!.ssn as Sealed<string>).reveal()).toBe(SSN)

    // (3) public get() returns a handle for ssn → gate intact.
    expect((r!.ssn as Sealed<string>).sealed).toBe(true)

    // (2) the LRU entry carries a handle, not sealed plaintext.
    const peeked = (buyers as unknown as { _peekCached(id: string): Buyer | null })._peekCached('b1')
    expect(isSealed(peeked!.ssn)).toBe(true)
  })

  it('a derivation MISS pass never poisons the LRU with sealed plaintext', async () => {
    const { buyers, sales } = await setup()
    await buyers.put('b1', { id: 'b1', companyName: 'Acme', ssn: SSN })
    // Evict the write-path LRU entry so the rollup recompute hits a MISS.
    ;(buyers as unknown as { lru: { clear?: () => void; remove: (id: string) => void } }).lru.remove('b1')

    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 42 })

    const peeked = (buyers as unknown as { _peekCached(id: string): Buyer | null })._peekCached('b1')
    expect(peeked).not.toBeNull()
    expect(isSealed(peeked!.ssn)).toBe(true)

    const r = await buyers.get('b1')
    expect(isSealed(r!.ssn)).toBe(true)
    expect(await (r!.ssn as Sealed<string>).reveal()).toBe(SSN)
    expect(r!.totalSpent).toBe(42)
  })
})
