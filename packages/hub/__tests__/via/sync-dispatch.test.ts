// The batched, origin-aware sync/cutover/restore dispatch wave (#621, #638 Task 4).
//
// mutation-choke-point.test.ts pins the exact side-effect set `_onRecordMutated` performs per
// origin (including the flipped sync-apply/MV pins). This file covers the WAVE's own semantics
// that aren't choke-point parity concerns: per-target dedup across a real multi-record pull(),
// the cutover/restore origins reaching the wave via `Vault._beginGraphBatch`/`_flushGraphBatch`,
// and id-threaded decrypt for a per-record-keyed source collection.

import { describe, it, expect, vi } from 'vitest'
import { createNoydb, withDerivation, withRollup } from '../../src/index.js'
import { withSync } from '../../src/with-party/sync/index.js'
import { lookup } from '../../src/shape/via-lookup/descriptor.js'
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
        const [vname, cname, id] = key.split('/') as [string, string, string]
        if (vname === v) { out[cname] = out[cname] ?? {}; out[cname]![id] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) data.set(k(v, c, i), payload[c]![i]!)
      }
    },
  }
}

const SECRET = 'sync-dispatch-wave-pass-2026'

interface Buyer extends Record<string, unknown> { id: string; totalSpent?: number }
interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }

describe('sync dispatch wave — per-target dedup (#621, #638 Task 4)', () => {
  it('pull(): N children of one rollup parent recompute the parent exactly ONCE (not N)', async () => {
    let computeCalls = 0
    const rollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => { computeCalls++; return sales.reduce((t, s) => t + s.total, 0) },
    })
    const remote = memory()
    // dbA does NOT register the rollup — it's a plain writer, so whatever `buyers.totalSpent`
    // dbB ends up with can only have come from dbB's OWN recompute, isolating the assertion below
    // from any pre-computed value merely riding along on the synced parent envelope.
    const dbA = await createNoydb({ store: memory(), sync: remote, user: 'user-a', syncStrategy: withSync(), encrypt: false })
    const dbB = await createNoydb({ store: memory(), sync: remote, user: 'user-b', syncStrategy: withSync(), encrypt: false, derivationStrategies: [rollup] })

    const vA = await dbA.openVault('demo')
    await vA.collection<Buyer>('buyers').put('b1', { id: 'b1' })
    await vA.collection<Sale>('sales').put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await vA.collection<Sale>('sales').put('s2', { id: 's2', buyerId: 'b1', total: 50 })
    await vA.collection<Sale>('sales').put('s3', { id: 's3', buyerId: 'b1', total: 25 })
    await dbA.push('demo')

    const vB = await dbB.openVault('demo') // must open to initialize sync engine + register the rollup
    // Collections must be declared this session for `_invalidateSyncApplied` to find them
    // (same as any other collection-cache lookup — a never-opened collection is a no-op).
    vB.collection<Buyer>('buyers'); vB.collection<Sale>('sales')
    computeCalls = 0 // isolate the count to what THIS pull's wave triggers

    const pullResult = await dbB.pull('demo')
    expect(pullResult.pulled).toBeGreaterThanOrEqual(4) // b1 + s1 + s2 + s3

    // Dedup collapses the 3 touched children into ONE wave-driven recompute. That recompute's
    // own output write to `buyers` then self-triggers ONE further recompute via the ORDINARY
    // local-write inline path (byte-identical, un-deduped — the #639-tracked hazard this task
    // must not worsen, not something it fixes) — total 2, not 4 (one compute per touched child
    // plus its own self-trigger, confirmed by disabling the dedup check during development).
    expect(computeCalls).toBe(2)
    expect((await vB.collection<Buyer>('buyers').get('b1'))?.totalSpent).toBe(175) // correct total from ALL 3 children
    dbA.close(); dbB.close()
  })
})

interface Pdf extends Record<string, unknown> { id: string; body: string }

describe('sync dispatch wave — cutover + restore origins (#621, #638 Task 4)', () => {
  function makeDerivation() {
    let calls = 0
    const handle = withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s: Pdf) => { calls++; return { meta: { len: s.body.length } } },
      lifecycle: 'eager',
    })
    return { handle, calls: () => calls }
  }

  it('cutover (_applyCutoverTransform), inside a graph-dispatch batch: dispatches derivations', async () => {
    const { handle, calls } = makeDerivation()
    const db = await createNoydb({ store: memory(), user: 'alice', secret: SECRET, derivationStrategies: [handle] })
    const vault = await db.openVault('demo')
    const pdfs = vault.collection<Pdf>('pdfs')
    await pdfs.put('doc1', { id: 'doc1', body: 'hello' })
    const before = calls()

    vault._beginGraphBatch()
    await pdfs._applyCutoverTransform((doc) => ({ ...doc, body: `${doc.body as string}!` }))
    await vault._flushGraphBatch()

    expect(calls()).toBe(before + 1)
    expect(await vault.collection<{ len: number } & Record<string, unknown>>('pdf-meta').get('doc1')).toMatchObject({ len: 6 }) // 'hello!'
    db.close()
  })

  it('restore origin, inside a graph-dispatch batch: dispatches derivations', async () => {
    const { handle, calls } = makeDerivation()
    const db = await createNoydb({ store: memory(), user: 'alice', secret: SECRET, derivationStrategies: [handle] })
    const vault = await db.openVault('demo')
    const pdfs = vault.collection<Pdf>('pdfs')
    await pdfs.put('doc1', { id: 'doc1', body: 'hello' })
    const before = calls()

    vault._beginGraphBatch()
    await pdfs._onRecordMutated('doc1', 'put', 'restore')
    await vault._flushGraphBatch()

    expect(calls()).toBe(before + 1)
    expect(await vault.collection<{ len: number } & Record<string, unknown>>('pdf-meta').get('doc1')).toMatchObject({ len: 5 })
    db.close()
  })
})

describe('sync dispatch wave — id-threaded decrypt for a per-record-keyed source (#621, #638 Task 4)', () => {
  interface Doc extends Record<string, unknown> { id: string; secret: string }

  it('perRecordKeys source: the wave decrypts the CORRECT record (id threaded, not a default/wrong key)', async () => {
    let seen: string | null = null
    const handle = withDerivation({
      source: 'docs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'doc-meta' } },
      derive: (s: Doc) => { seen = s.secret; return { meta: { len: s.secret.length } } },
      lifecycle: 'eager',
    })
    const store = memory()
    const db1 = await createNoydb({ store, user: 'alice', secret: SECRET, derivationStrategies: [handle] })
    const v1 = await db1.openVault('demo')
    const docs1 = v1.collection<Doc>('docs', { perRecordKeys: true })
    await docs1.put('seed', { id: 'seed', secret: 'zzzzzzzz' }) // mints + persists the shared per-record-keyed collection state

    const db2 = await createNoydb({ store, user: 'alice', secret: SECRET, derivationStrategies: [handle] })
    const v2 = await db2.openVault('demo')
    const docs2 = v2.collection<Doc>('docs', { perRecordKeys: true })
    await docs2.get('seed') // hydrate db2's cache under the shared per-record keys

    await docs1.put('d1', { id: 'd1', secret: 'abcdefghij' }) // db1's own local-write, into the shared store

    v2._beginGraphBatch()
    await v2._invalidateSyncApplied('docs', 'd1')
    await v2._flushGraphBatch()

    expect(seen).toBe('abcdefghij') // the wave's decrypt (id: 'd1') recovered the RIGHT plaintext
    expect(await v2.collection<{ len: number } & Record<string, unknown>>('doc-meta').get('d1')).toMatchObject({ len: 10 })
    db1.close(); db2.close()
  })
})

describe('sync dispatch wave — ref edges excluded from dependentsOf (#650 Task 5 review, folded Minor)', () => {
  interface Country extends Record<string, unknown> { id: string; name: string }
  interface Traveler extends Record<string, unknown> { id: string; country: string }

  it('pull(): a write to a referenced-only backing collection (a `ref` edge, no derivations) skips the wave — no decrypt', async () => {
    const remote = memory()
    const dbA = await createNoydb({ store: memory(), sync: remote, user: 'user-a', syncStrategy: withSync(), encrypt: false })
    const dbB = await createNoydb({ store: memory(), sync: remote, user: 'user-b', syncStrategy: withSync(), encrypt: false })

    const vA = await dbA.openVault('demo')
    await vA.collection<Country>('countries').put('US', { id: 'US', name: 'United States' })
    await dbA.push('demo')

    const vB = await dbB.openVault('demo')
    const countriesB = vB.collection<Country>('countries', {})
    // Declares the 'ref' edge countries -> travelers.country (cascade); countries itself has
    // no derivation/rollup/mv — dependentsOf('countries') must be empty post-fix.
    vB.collection<Traveler>('travelers', { lookupFields: { country: lookup('countries', { onDelete: 'cascade' }) } })
    const decryptSpy = vi.spyOn(countriesB, '_getStoredRecordForDispatch')

    const pullResult = await dbB.pull('demo')

    expect(pullResult.pulled).toBeGreaterThanOrEqual(1)
    expect(decryptSpy).not.toHaveBeenCalled() // #553 zero-cost skip: the wave never touched 'countries'
    expect(await countriesB.get('US')).toMatchObject({ id: 'US', name: 'United States' }) // the write itself still applied
    dbA.close(); dbB.close()
  })
})
