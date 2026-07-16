/**
 * #715/#716 — the write ring. A tier-0 put()/delete() targeting an elevated
 * record is refused uniformly (spec: docs/superpowers/specs/2026-07-16-write-ring-refusal-design.md).
 * Holders are refused too: put()/delete() are the tier-0 APIs; putAtTier/
 * elevate/demote are the sanctioned tier-aware paths.
 *
 * Task 1 scope: the error-contract test only. Task 2 wires assertTierWritable
 * into collection.ts's choke points and appends the integration tests.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, TierWriteRefusedError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withCrdt } from '../src/with-commit/crdt/index.js'
import { assertTierWritable } from '../src/kernel/tier-visibility.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'
import { ConflictError } from '../src/index.js'

describe('#715 TierWriteRefusedError', () => {
  it('names the collection, the tier, and the remedy', () => {
    const e = new TierWriteRefusedError('docs', 2)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('TierWriteRefusedError')
    expect(e.collection).toBe('docs')
    expect(e.tier).toBe(2)
    expect(e.message).toMatch(/putAtTier/) // actionable remedy named
  })
})

interface Doc {
  id: string
  title: string
  body: string
}

// Copied verbatim from __tests__/hierarchical-tiers.test.ts.
function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
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

describe('#715/#716 write ring: tier-0 put/delete over an elevated record are refused', () => {
  async function open(opts: { lazy?: boolean; crdt?: boolean } = {}) {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw-715', user: 'owner', tiersStrategy: withTiers(),
      ...(opts.crdt ? { crdtStrategy: withCrdt() } : {}),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true,
      ...(opts.lazy ? { prefetch: false, cache: { maxRecords: 100 } } : {}),
      ...(opts.crdt ? { crdt: 'lww-map' as const } : {}),
    })
    return { store, docs }
  }

  for (const mode of ['eager', 'lazy'] as const) {
    it(`${mode}: put() over an elevated id is refused (no demotion, no history snapshot)`, async () => {
      const { store, docs } = await open({ lazy: mode === 'lazy' })
      await docs.put('d1', { id: 'd1', title: 'secret', body: 'x' })
      await docs.elevate('d1', 1)
      // Pre-fix: eager/lazy SILENTLY DEMOTED (_tier 1 → undefined); lazy also
      // wrote a history snapshot of the elevated plaintext.
      await expect(docs.put('d1', { id: 'd1', title: 'clobber', body: 'y' })).rejects.toBeInstanceOf(TierWriteRefusedError)
      expect((await store.get('v1', 'docs', 'd1'))!._tier).toBe(1)   // tier intact — the core #715 pin
    })

    it(`${mode}: delete() over an elevated id is refused — no marker, history stays hidden (#716)`, async () => {
      const { store, docs } = await open({ lazy: mode === 'lazy' })
      await docs.put('d1', { id: 'd1', title: 'secret', body: 'x' })
      await docs.elevate('d1', 1)
      await expect(docs.delete('d1')).rejects.toBeInstanceOf(TierWriteRefusedError)
      expect((await store.get('v1', 'docs', 'd1'))!._tier).toBe(1)   // no marker overwrote it
    })
  }

  it('CRDT: put() over an elevated id is refused with the SAME error (was TamperedError/InvalidKeyError)', async () => {
    const { docs } = await open({ crdt: true })
    await docs.put('c1', { id: 'c1', title: 'secret', body: 'x' })
    await docs.elevate('c1', 1)
    await expect(docs.put('c1', { id: 'c1', title: 'clobber', body: 'y' })).rejects.toBeInstanceOf(TierWriteRefusedError)
  })

  it('the elevating owner (who HOLDS the tier DEK) is refused too — put() is the tier-0 API', async () => {
    const { docs } = await open()
    await docs.put('d1', { id: 'd1', title: 'secret', body: 'x' })
    await docs.elevate('d1', 1)   // this session holds docs#1
    await expect(docs.put('d1', { id: 'd1', title: 'x2', body: 'y' })).rejects.toBeInstanceOf(TierWriteRefusedError)
    await docs.putAtTier('d1', { id: 'd1', title: 'sanctioned', body: 'y' }, 1)  // sanctioned path still works
    expect(((await docs.getAtTier('d1')) as Doc | null)?.title).toBe('sanctioned')
  })

  it('a tier-0 record in a tiered collection is unaffected — put/delete proceed normally', async () => {
    const { docs } = await open()
    await docs.put('d0', { id: 'd0', title: 'plain', body: 'x' })
    await docs.put('d0', { id: 'd0', title: 'updated', body: 'y' })   // tier-0 overwrite fine
    expect((await docs.get('d0'))?.title).toBe('updated')
    await docs.delete('d0')
    expect(await docs.get('d0')).toBeNull()
  })

  it('a collection that never declares tiers is unaffected — put/delete proceed normally', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw-715-nt', user: 'owner' })
    const vault = await db.openVault('v1')
    const plain = vault.collection<Doc>('plain', {})   // no `tiers` → this.tiers === null
    await plain.put('p1', { id: 'p1', title: 'a', body: 'x' })
    await plain.put('p1', { id: 'p1', title: 'b', body: 'y' })
    expect((await plain.get('p1'))?.title).toBe('b')
    await plain.delete('p1')
    expect(await plain.get('p1')).toBeNull()
  })

  it('assertTierWritable costs a non-tiered collection ZERO adapter round-trips', async () => {
    // The `no extra cost` half of the design's cost gate, pinned directly:
    // with tiers off the helper must short-circuit BEFORE touching the store.
    // Asserted against an adapter that throws if consulted at all — a call
    // count could drift silently, this cannot.
    const exploding = new Proxy({} as NoydbStore, {
      get() { throw new Error('assertTierWritable touched the adapter with tiers disabled') },
    })
    await expect(assertTierWritable(exploding, 'v1', 'plain', 'p1', false)).resolves.toBeUndefined()
  })

  it('#716: after the refusal, an elevated record’s history stays hidden (delete cannot erase the signal)', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw-716', user: 'owner', tiersStrategy: withTiers(), historyStrategy: withHistory() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs.put('d1', { id: 'd1', title: 'v1', body: 'x' })
    await docs.put('d1', { id: 'd1', title: 'v2', body: 'y' })
    await docs.elevate('d1', 1)
    await expect(docs.delete('d1')).rejects.toBeInstanceOf(TierWriteRefusedError)
    // Pre-fix: delete() wrote a marker with no `_tier`, erasing the elevation
    // signal — the elevated record's prior versions would then re-decrypt
    // through #712's live-peek gate.
    expect(await docs.history('d1')).toEqual([])
  })
})
