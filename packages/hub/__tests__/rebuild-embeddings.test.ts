/**
 * #788 — opt-in `Collection.rebuildEmbeddings()` bulk `_vec` re-derive.
 *
 * After #726 re-namespaced `_vec` sidecars to `_vec/<collection>/<recordId>`,
 * legacy bare-id rows are unreachable to `buildVectorLoad` and only self-heal
 * when a record is next `put()`. This adds an opt-in bulk utility to
 * force-re-derive every eligible record's sidecar once.
 *
 * Fixture pattern mirrors `embeddings-vec-namespace.test.ts` (memoryStore +
 * deterministic stub encoder) and `satellites-cek-migration.test.ts` (the
 * put-failure spy store for the resumability test).
 *
 * The load-bearing invariant under test: an ELEVATED record must never get a
 * `_vec` row written for it by this walk — it must be counted in `skipped`
 * instead, mirrored against the raw store, never merely inferred from the
 * public API.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withSearch, ConflictError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { SearchNotEnabledError } from '../src/kernel/errors.js'
import { memory } from '../../to-memory/src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

interface Doc {
  id: string
  body: string
}

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

// Deterministic stub encoder: 8-dim bag-of-chars hash → Float32Array.
const enc = (dim: number, model = 'stub') => ({
  dim, model, source: 'body' as const,
  encode: async (t: string) => { const v = new Float32Array(dim); for (let i = 0; i < t.length; i++) { const idx = t.charCodeAt(i) % dim; v[idx] = (v[idx] ?? 0) + 1 } return v },
})
const ENCODER = enc(8)

const SECRET = 'rebuild-embeddings-secret-788'

describe('#788 Collection.rebuildEmbeddings()', () => {
  it('rebuilds every live tier-0 record\'s missing/stale _vec sidecar; round-trips through similarTo()', async () => {
    const store = memoryStore()

    // Session 1: no embeddings config at all — simulates records written
    // before the collection ever opted into embeddings (the #726 legacy
    // scenario), so no `_vec` row is ever derived for them.
    const db1 = await createNoydb({ store, user: 'owner', secret: SECRET })
    const vault1 = await db1.openVault('v1')
    const docs1 = vault1.collection<Doc>('docs', {})
    await docs1.put('a', { id: 'a', body: 'alpha content one' })
    await docs1.put('b', { id: 'b', body: 'bravo content two' })
    await docs1.put('c', { id: 'c', body: 'charlie content three' })

    // Session 2 (cold reopen): opt into search + embeddings for the first time.
    const db2 = await createNoydb({ store, user: 'owner', secret: SECRET, searchStrategy: withSearch() })
    const vault2 = await db2.openVault('v1')
    const docs2 = vault2.collection<Doc>('docs', { embeddings: ENCODER })

    expect(await store.get('v1', '_vec', 'docs/a')).toBeNull()
    expect(await store.get('v1', '_vec', 'docs/b')).toBeNull()
    expect(await store.get('v1', '_vec', 'docs/c')).toBeNull()

    const result = await docs2.rebuildEmbeddings()
    expect(result).toEqual({ rebuilt: 3, skipped: 0 })

    expect(await store.get('v1', '_vec', 'docs/a')).not.toBeNull()
    expect(await store.get('v1', '_vec', 'docs/b')).not.toBeNull()
    expect(await store.get('v1', '_vec', 'docs/c')).not.toBeNull()

    const qVec = await ENCODER.encode('alpha content one')
    const hits = await docs2.similarTo(qVec, { k: 1 })
    expect(hits.map((h) => h.id)).toEqual(['a'])
  })

  it('overwrites a stale/corrupt _vec row with a freshly-derived one', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'owner', secret: SECRET, searchStrategy: withSearch() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { embeddings: ENCODER })
    await docs.put('a', { id: 'a', body: 'alpha content one' })

    const freshRow = await store.get('v1', '_vec', 'docs/a')
    expect(freshRow).not.toBeNull()

    // Corrupt the sidecar in place (simulate a stale row from before a
    // content edit that never went through embedOnWrite, e.g. a raw
    // migration write).
    await store.put('v1', '_vec', 'docs/a', { ...freshRow!, _data: freshRow!._data + 'garbage-suffix' })

    const result = await docs.rebuildEmbeddings()
    expect(result).toEqual({ rebuilt: 1, skipped: 0 })

    const qVec = await ENCODER.encode('alpha content one')
    const hits = await docs.similarTo(qVec, { k: 1 })
    expect(hits.map((h) => h.id)).toEqual(['a'])
  })

  it('SKIPS an elevated record: no _vec row is written for it, and it is counted in `skipped` — the load-bearing invariant', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, user: 'owner', secret: SECRET,
      searchStrategy: withSearch(),
      tiersStrategy: withTiers(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1],
      perRecordKeys: true,
      embeddings: ENCODER,
    })
    await docs.put('e1', { id: 'e1', body: 'topsecret elevated content' })
    await docs.put('t0', { id: 't0', body: 'public tier-0 content' })

    // e1's _vec was derived on put(); elevate() purges it (syncTierSearch).
    expect(await store.get('v1', '_vec', 'docs/e1')).not.toBeNull()
    await docs.elevate('e1', 1)
    expect(await store.get('v1', '_vec', 'docs/e1')).toBeNull()

    const result = await docs.rebuildEmbeddings()
    expect(result).toEqual({ rebuilt: 1, skipped: 1 })

    // Direct raw-store assertion — the crux: rebuildEmbeddings must NOT
    // resurrect a _vec row for the elevated record.
    expect(await store.get('v1', '_vec', 'docs/e1')).toBeNull()
    expect(await store.get('v1', '_vec', 'docs/t0')).not.toBeNull()
  })

  it('skips a crypto-shred tombstone row without error (forget() leaves the id key in place, body unreadable)', async () => {
    const store = memoryStore()
    interface Subject extends Doc { ownerId?: string }
    const db = await createNoydb({
      store, user: 'owner', secret: SECRET,
      searchStrategy: withSearch(),
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { docs: 'ownerId' } }),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Subject>('docs', { embeddings: ENCODER })
    await docs.put('a', { id: 'a', body: 'alpha content one' })
    await docs.put('b', { id: 'b', body: 'bravo content two', ownerId: 'bob' })

    const forgetResult = await vault.forget('bob')
    expect(forgetResult.recordsShredded).toBe(1)
    // forget() tombstones the envelope in place — the id key survives in
    // adapter.list(), but its body is unreadable (isTombstone).
    expect(await store.get('v1', 'docs', 'b')).not.toBeNull()

    // The tombstone must not be re-derived; only the live record ('a')
    // counts toward `rebuilt`, and the tombstoned id counts toward `skipped`.
    const result = await docs.rebuildEmbeddings()
    expect(result).toEqual({ rebuilt: 1, skipped: 1 })
  })

  it('collection WITHOUT embeddings config returns {rebuilt:0, skipped:0} and does not throw', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'owner', secret: SECRET })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {})
    await docs.put('a', { id: 'a', body: 'alpha content one' })

    await expect(docs.rebuildEmbeddings()).resolves.toEqual({ rebuilt: 0, skipped: 0 })
  })

  it('collection with embeddings declared but NO withSearch() throws SearchNotEnabledError', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'owner', secret: SECRET })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { embeddings: ENCODER })

    await expect(docs.rebuildEmbeddings()).rejects.toBeInstanceOf(SearchNotEnabledError)
  })

  it('resumability: a store put-failure mid-walk leaves earlier records rebuilt; a re-run completes', async () => {
    const rawStore = memory()

    const db1 = await createNoydb({ store: rawStore, user: 'owner', secret: SECRET })
    const vault1 = await db1.openVault('v1')
    const docs1 = vault1.collection<Doc>('docs', {})
    await docs1.put('a', { id: 'a', body: 'alpha' })
    await docs1.put('b', { id: 'b', body: 'bravo' })
    await docs1.put('c', { id: 'c', body: 'charlie' })

    // Fail the SECOND record's _vec write mid-walk.
    let putCount = 0
    const spy2: NoydbStore = {
      ...rawStore,
      async put(vault, coll, id, env, expectedVersion) {
        if (coll === '_vec') {
          putCount++
          if (putCount === 2) throw new Error('spy: injected failure for put("_vec") #2')
        }
        return rawStore.put(vault, coll, id, env, expectedVersion)
      },
    }
    const db2b = await createNoydb({ store: spy2, user: 'owner', secret: SECRET, searchStrategy: withSearch() })
    const vault2b = await db2b.openVault('v1')
    const docs2b = vault2b.collection<Doc>('docs', { embeddings: ENCODER })

    await expect(docs2b.rebuildEmbeddings()).rejects.toThrow()

    const vecCountBefore = (await rawStore.list('v1', '_vec')).length
    expect(vecCountBefore).toBe(1) // exactly one landed before the injected failure

    // Resume with a clean store (no further injected failures).
    const db3 = await createNoydb({ store: rawStore, user: 'owner', secret: SECRET, searchStrategy: withSearch() })
    const vault3 = await db3.openVault('v1')
    const docs3 = vault3.collection<Doc>('docs', { embeddings: ENCODER })

    const result = await docs3.rebuildEmbeddings()
    expect(result).toEqual({ rebuilt: 3, skipped: 0 })

    expect(await rawStore.get('v1', '_vec', 'docs/a')).not.toBeNull()
    expect(await rawStore.get('v1', '_vec', 'docs/b')).not.toBeNull()
    expect(await rawStore.get('v1', '_vec', 'docs/c')).not.toBeNull()
  })
})
