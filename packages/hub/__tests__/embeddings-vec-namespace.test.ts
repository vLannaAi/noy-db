/**
 * #726 — `_vec` embedding sidecars are collection-namespaced. Before this
 * fix, `_vec` rows were keyed by the bare record id, vault-wide: two
 * collections sharing a record id shared ONE `_vec` row.
 *
 * This is NOT a confidentiality-disclosure bug: every collection has its own
 * DEK, and AES-GCM auth-tag verification means decrypting a foreign
 * collection's row under the wrong DEK throws `TamperedError` rather than
 * returning wrong plaintext — verified empirically, no two ordinary
 * collections share a DEK, so a cross-collection read cannot occur. The real
 * bug was id collision: (a) writing/forgetting a record in A could clobber
 * or delete B's same-id sidecar, and (b) a collection whose `similarTo()` /
 * cold semantic `retrieve()` encountered a foreign same-id row crashed with
 * an uncaught `TamperedError` (a denial-of-service). Fixture pattern mirrors
 * `tiers-search.test.ts` (memoryStore + stub encoder) and
 * `embeddings-forget.test.ts` (forget harness).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withSearch, ConflictError } from '../src/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withForget } from '../src/with-audit/forget/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

interface Doc {
  id: string
  body: string
  ownerId?: string
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

const SECRET = 'vec-namespace-secret-726'

describe('#726 crash/clobber closed: same record id in two collections neither collides nor crashes similarTo() (NOT a disclosure bug)', () => {
  it('A.similarTo() returns only A\'s own "x" row — no TamperedError crash, no blending of B\'s content', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'owner', secret: SECRET, searchStrategy: withSearch() })
    const vault = await db.openVault('v1')
    const a = vault.collection<Doc>('a', { embeddings: ENCODER })
    const b = vault.collection<Doc>('b', { embeddings: ENCODER })

    // Both collections hold record id 'x' with different content. Under
    // pre-#726 bare-id keying this pair collided on a single '_vec/x' row:
    // B's put() below would silently CLOBBER A's row with B's ciphertext
    // (encrypted under B's DEK, since A and B never share a DEK).
    await a.put('x', { id: 'x', body: 'alpha content from collection A' })
    await b.put('x', { id: 'x', body: 'zzzzzzzzzzzz totally different from B' })

    const aQVec = await ENCODER.encode('alpha content from collection A')
    // Pre-fix: buildVectorLoad for A would find the (now B-owned) '_vec/x'
    // row, pass A's OWN elevation gate (checked against A's live record, not
    // B's), then try to decrypt B's ciphertext under A's DEK. AES-GCM
    // auth-tag verification fails on a wrong-key decrypt, so this THROWS an
    // uncaught TamperedError (a crash / DoS) — it never returns B's
    // plaintext to A. The fix (collection-namespaced ids) means A only ever
    // sees its own 'a/x' row: no throw, no clobber, no blending.
    const hits = await a.similarTo(aQVec)
    expect(hits.map((h) => h.id)).toContain('x')
    expect(hits).toHaveLength(1)
  })
})

describe('#726 isolation: same record id in two collections keeps separate _vec rows', () => {
  it('writing A\'s x does not clobber B\'s x', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'owner', secret: SECRET, searchStrategy: withSearch() })
    const vault = await db.openVault('v2')
    const a = vault.collection<Doc>('a', { embeddings: ENCODER })
    const b = vault.collection<Doc>('b', { embeddings: ENCODER })

    await a.put('x', { id: 'x', body: 'alpha content from collection A' })
    await b.put('x', { id: 'x', body: 'zzzzzzzzzzzz totally different from B' })

    const aRow = await store.get('v2', '_vec', 'a/x')
    const bRow = await store.get('v2', '_vec', 'b/x')
    expect(aRow).not.toBeNull()
    expect(bRow).not.toBeNull()
    expect(JSON.stringify(aRow)).not.toEqual(JSON.stringify(bRow))

    // Each collection's similarTo() still finds its own 'x'.
    const aQVec = await ENCODER.encode('alpha content from collection A')
    expect((await a.similarTo(aQVec)).map((h) => h.id)).toContain('x')
    const bQVec = await ENCODER.encode('zzzzzzzzzzzz totally different from B')
    expect((await b.similarTo(bQVec)).map((h) => h.id)).toContain('x')
  })

  it('forgetting A\'s x does not delete B\'s x sidecar', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, user: 'owner', secret: SECRET,
      searchStrategy: withSearch(),
      historyStrategy: withHistory(),
      forgetStrategy: withForget({ subjects: { a: 'ownerId', b: 'ownerId' } }),
    })
    const vault = await db.openVault('v3')
    const a = vault.collection<Doc>('a', { embeddings: ENCODER })
    const b = vault.collection<Doc>('b', { embeddings: ENCODER })

    await a.put('x', { id: 'x', body: 'alpha content from collection A', ownerId: 'alice' })
    await b.put('x', { id: 'x', body: 'zzzzzzzzzzzz totally different from B', ownerId: 'bob' })
    expect(await store.get('v3', '_vec', 'a/x')).not.toBeNull()
    expect(await store.get('v3', '_vec', 'b/x')).not.toBeNull()

    const result = await vault.forget('alice')
    expect(result.recordsShredded).toBe(1)

    expect(await store.get('v3', '_vec', 'a/x')).toBeNull()
    expect(await store.get('v3', '_vec', 'b/x')).not.toBeNull() // untouched

    const bQVec = await ENCODER.encode('zzzzzzzzzzzz totally different from B')
    expect((await b.similarTo(bQVec)).map((h) => h.id)).toContain('x')
  })
})

describe('#726 residual gap: a surviving "<collection>/" row that cannot be decrypted is skipped, not fatal', () => {
  it('similarTo() returns own legitimate results and does not throw on a poison row', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, user: 'owner', secret: SECRET, searchStrategy: withSearch() })
    const vault = await db.openVault('v4')
    const a = vault.collection<Doc>('a', { embeddings: ENCODER })
    const b = vault.collection<Doc>('b', { embeddings: ENCODER })

    await a.put('x', { id: 'x', body: 'alpha content from collection A' })
    await b.put('y', { id: 'y', body: 'zzzzzzzzzzzz totally different from B' })

    // Simulate a surviving legacy/foreign row: an id that still begins with
    // 'a/' (so it passes A's isVecIdFor prefix filter and decodes to a
    // record id, 'poison', that never exists in A — the elevation gate
    // peeks A's own live envelope for that id and finds none, so it does not
    // skip this row either) but whose ciphertext was written under B's DEK.
    // Decrypting it under A's DEK fails AES-GCM auth-tag verification.
    const bRow = await store.get('v4', '_vec', 'b/y')
    expect(bRow).not.toBeNull()
    await store.put('v4', '_vec', 'a/poison', bRow!)

    const aQVec = await ENCODER.encode('alpha content from collection A')
    const hits = await a.similarTo(aQVec)
    expect(hits.map((h) => h.id)).toEqual(['x'])
  })
})
