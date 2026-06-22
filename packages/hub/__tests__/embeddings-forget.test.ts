/**
 * forget() teardown of _vec sidecars — encrypted vector erasure (#308 L2).
 *
 * Harness: forget.test.ts (withForgetCascade/forgetStrategy wiring +
 * memory store with raw-envelope inspection) + enc() stub from
 * embeddings-write.test.ts.
 *
 * 3 cases:
 *  1. After vault.forget(subject), adapter.get(vault,'_vec',recordId) === null
 *     AND a subsequent retrieve(mode:'semantic') excludes the forgotten record.
 *  2. Resilience: a store whose delete() throws for '_vec' cols →
 *     forget resolves (no throw) + residue surfaced in ForgetResult.
 *  3. Idempotent: second forget on same subject → 0 shredded, still no _vec.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { withHistory } from '../src/history/index.js'
import { withForgetCascade } from '../src/forget/index.js'

// ── in-memory store with raw-envelope inspection (from forget.test.ts) ──────

function memory(): NoydbStore & {
  raw(c: string, col: string, id: string): EncryptedEnvelope | undefined
} {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
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

// ── deterministic stub encoder (from embeddings-write.test.ts) ───────────────

const enc = (dim: number, model = 'stub') => ({
  dim, model, source: 'text' as const,
  encode: async (t: string) => {
    const v = new Float32Array(dim)
    for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % dim] += 1
    return v
  },
})

interface Doc { id: string; text: string; ownerId: string }

const SECRET = 'forget-vec-test-passphrase-5678'

// ── Case 1: _vec sidecar deleted + excluded from semantic retrieve ────────────

describe('embeddings forget — case 1: _vec purged + excluded from retrieve', () => {
  it('forget deletes the _vec sidecar and excludes the forgotten record from semantic retrieve', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { docs: 'ownerId' } }),
    })
    const vault = await db.openVault('vec-v')
    const encoder = enc(8)
    const docs = vault.collection<Doc>('docs', { embeddings: encoder })

    // Write two records belonging to different owners.
    await docs.put('doc-a', { id: 'doc-a', text: 'overdue invoice payment', ownerId: 'alice' })
    await docs.put('doc-b', { id: 'doc-b', text: 'client account setup', ownerId: 'bob' })

    // Both _vec sidecars exist before forget.
    expect(await store.get('vec-v', '_vec', 'doc-a')).not.toBeNull()
    expect(await store.get('vec-v', '_vec', 'doc-b')).not.toBeNull()

    // Forget alice's record.
    const result = await vault.forget('alice')
    expect(result.recordsShredded).toBe(1)

    // doc-a's _vec sidecar must be gone.
    expect(await store.get('vec-v', '_vec', 'doc-a')).toBeNull()

    // doc-b's _vec sidecar must be intact.
    expect(await store.get('vec-v', '_vec', 'doc-b')).not.toBeNull()

    // Semantic retrieve must exclude the forgotten record.
    // Open a fresh vault so the in-memory vectorSet is cold and rebuilt from store.
    const db2 = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { docs: 'ownerId' } }),
    })
    const vault2 = await db2.openVault('vec-v')
    const docs2 = vault2.collection<Doc>('docs', { embeddings: encoder })
    const hits = await docs2.retrieve('overdue invoice payment', { mode: 'semantic' })
    const ids = hits.map((h) => h.id)
    expect(ids).not.toContain('doc-a')
  })
})

// ── Case 2: resilience — delete throws for _vec → resolves + residue surfaced ─

describe('embeddings forget — case 2: resilience (delete throws for _vec)', () => {
  it('forget resolves when _vec delete throws, surfaces residue in ForgetResult', async () => {
    const base = memory()
    // Wrap the store so delete() throws for the _vec collection.
    const faultyStore: NoydbStore = {
      ...base,
      async delete(c, col, id) {
        if (col === '_vec') throw new Error('_vec store unavailable')
        return base.delete(c, col, id)
      },
    }
    const db = await createNoydb({
      store: faultyStore, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { docs: 'ownerId' } }),
    })
    const vault = await db.openVault('vec-r')
    const docs = vault.collection<Doc>('docs', { embeddings: enc(4) })
    await docs.put('doc-x', { id: 'doc-x', text: 'test document', ownerId: 'carol' })

    // forget must NOT throw even though _vec delete fails.
    const result = await vault.forget('carol')

    // The record was still tombstoned.
    expect(result.recordsShredded).toBe(1)

    // The _vec failure must appear in indexResidue.
    expect(result.indexResidue).toContain('docs:doc-x:_vec')
  })
})

// ── Case 3: idempotent second forget ─────────────────────────────────────────

describe('embeddings forget — case 3: idempotent second forget', () => {
  it('second forget on same subject shreds 0 records and leaves no _vec', async () => {
    const store = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: SECRET,
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { docs: 'ownerId' } }),
    })
    const vault = await db.openVault('vec-i')
    const docs = vault.collection<Doc>('docs', { embeddings: enc(8) })
    await docs.put('doc-y', { id: 'doc-y', text: 'some text', ownerId: 'dave' })

    // First forget.
    await vault.forget('dave')
    expect(await store.get('vec-i', '_vec', 'doc-y')).toBeNull()

    // Second forget — idempotent, no throw.
    const result2 = await vault.forget('dave')
    expect(result2.recordsShredded).toBe(0)
    expect(await store.get('vec-i', '_vec', 'doc-y')).toBeNull()
  })
})
