/**
 * #715/#716 — the write ring. A tier-0 put()/delete() targeting an elevated
 * record is refused uniformly (spec: design-history/2026-07-16-write-ring-refusal-design.md).
 * Holders are refused too: put()/delete() are the tier-0 APIs; putAtTier/
 * elevate/demote are the sanctioned tier-aware paths.
 *
 * Task 1 scope: the error-contract test only. Task 2 wires assertTierWritable
 * into collection.ts's choke points and appends the integration tests.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, TierWriteRefusedError, withDerivation } from '../src/index.js'
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

describe('#718: internal deletes skip elevated records (the write ring covers machinery paths)', () => {
  interface Worker extends Record<string, unknown> {
    id: string
    employmentPeriods: ReadonlyArray<{ from: string; to: string }>
  }
  interface ActivePeriod extends Record<string, unknown> {
    id: string
    workerId: string
    period: string
  }

  it('REPRO (#718): an array-shape derivation output row, elevated, survives a source-driven fanout shrink — a sibling non-elevated row is still cleaned up', async () => {
    // #718's exact scenario: a tiered derivation/MV OUTPUT collection with an
    // elevated row, cleanup pass (here: fanout shrink on source update) targets
    // it. Pre-fix: `_doDelete(id, true)` was ungated for `internal` — since this
    // store has no `onDirty`, it fell through to `adapter.delete`, silently
    // ERASING the elevated derived row outright (worse than #716's bare marker).
    const rawStore = memoryStore()
    const strategy = withDerivation<Worker, { activeInPeriod: ActivePeriod[] }>({
      source: 'workers',
      deterministic: true,
      outputs: { activeInPeriod: { shape: 'array', collection: 'workerActiveInPeriod', key: (o) => `${o['workerId'] as string}|${o['period'] as string}`, maxFanout: 12 } },
      derive: (worker) => ({
        activeInPeriod: worker.employmentPeriods.map(p => ({ id: `${worker.id}|${p.from}`, workerId: worker.id, period: p.from })),
      }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({ store: rawStore, user: 'alice', secret: 'pw-718-repro', derivationStrategies: [strategy], tiersStrategy: withTiers() })
    const vault = await db.openVault('acme')
    const workers = vault.collection<Worker>('workers')
    const activePeriods = vault.collection<ActivePeriod>('workerActiveInPeriod', { tiers: [0, 1], perRecordKeys: true })

    await workers.put('w1', { id: 'w1', employmentPeriods: [{ from: '2026-03', to: '2026-03' }, { from: '2026-04', to: '2026-04' }] })
    expect(await rawStore.get('acme', 'workerActiveInPeriod', 'w1|2026-03')).not.toBeNull()
    expect(await rawStore.get('acme', 'workerActiveInPeriod', 'w1|2026-04')).not.toBeNull()

    await activePeriods.elevate('w1|2026-03', 1)

    // Shrink: drop both periods — the fanout diff calls _internalDelete on
    // BOTH derived ids. The elevated one must survive untouched; the plain
    // one must still be erased (internal cleanup keeps working normally).
    await workers.put('w1', { id: 'w1', employmentPeriods: [] })

    const elevated = await rawStore.get('acme', 'workerActiveInPeriod', 'w1|2026-03')
    expect(elevated).not.toBeNull()
    expect(elevated!._tier).toBe(1) // untouched: no marker, no erasure, tier signal intact
    expect(await rawStore.get('acme', 'workerActiveInPeriod', 'w1|2026-04')).toBeNull() // sibling cleanup unaffected
  })

  it('at the _doDelete level: an internal delete over an elevated id is a no-op (no marker, tier intact); a non-elevated id still deletes', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw-718-unit', user: 'owner', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs.put('d1', { id: 'd1', title: 'secret', body: 'x' })
    await docs.put('d2', { id: 'd2', title: 'plain', body: 'y' })
    await docs.elevate('d1', 1)

    // `_internalDelete`'s own prior-read sees a live envelope before `_doDelete`'s
    // skip fires, but `_doDelete` itself now reports the skip (#761 item 8) — the
    // record is genuinely untouched (verified below), and the caller CAN tell
    // "skipped" from "erased" via this return value.
    expect(await docs._internalDelete('d1')).toBe(false)
    expect((await store.get('v1', 'docs', 'd1'))!._tier).toBe(1)

    expect(await docs._internalDelete('d2')).toBe(true) // ordinary internal cleanup unaffected
    expect(await store.get('v1', 'docs', 'd2')).toBeNull()
  })
})

describe('#708 sharp edge: coordinated cutover refuses an elevated record', () => {
  it('cutover on a collection with an elevated record throws BEFORE any rewrite — all-or-nothing', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw-708-cutover', user: 'owner', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs.put('d1', { id: 'd1', title: 'a', body: 'x' })
    await docs.put('d2', { id: 'd2', title: 'b', body: 'y' })
    await docs.elevate('d1', 1)
    const v1Before = (await store.get('v1', 'docs', 'd1'))!._v
    const v2Before = (await store.get('v1', 'docs', 'd2'))!._v

    const err = await docs._applyCutoverTransform(d => ({ ...d, title: 'clobbered' })).catch(e => e)
    expect(err).toBeInstanceOf(TierWriteRefusedError)
    expect((err as InstanceType<typeof TierWriteRefusedError>).collection).toBe('docs')
    expect((err as InstanceType<typeof TierWriteRefusedError>).tier).toBe(1)

    // NO record was rewritten — not even the non-elevated one that sorts first.
    expect((await store.get('v1', 'docs', 'd1'))!._v).toBe(v1Before)
    expect((await store.get('v1', 'docs', 'd2'))!._v).toBe(v2Before)
  })

  it('the refusal names the collection, the offending id, and "demote before a coordinated cutover"', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw-708-msg', user: 'owner', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs.put('d1', { id: 'd1', title: 'a', body: 'x' })
    await docs.elevate('d1', 1)
    await expect(docs._applyCutoverTransform(d => d)).rejects.toThrow(/docs.*d1.*demote.*coordinated cutover/is)
  })

  it('after demote, the cutover proceeds normally', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw-708-demote', user: 'owner', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs.put('d1', { id: 'd1', title: 'a', body: 'x' })
    await docs.elevate('d1', 1)
    await docs.demote('d1', 0)

    const count = await docs._applyCutoverTransform(d => ({ ...d, title: 'migrated' }))
    expect(count).toBe(1)
    expect((await docs.get('d1'))?.title).toBe('migrated')
  })

  it('a collection that never declares tiers pays no extra cost on cutover', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw-708-nt', user: 'owner' })
    const vault = await db.openVault('v1')
    const plain = vault.collection<Doc>('plain', {})
    await plain.put('p1', { id: 'p1', title: 'a', body: 'x' })
    const count = await plain._applyCutoverTransform(d => ({ ...d, title: 'b' }))
    expect(count).toBe(1)
  })
})
