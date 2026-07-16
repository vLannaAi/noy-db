/**
 * #721 — tiers × search. The `_ftindex` lexical blob (full verbatim field
 * text) and the `_vec/<id>` embedding are both encrypted under the tier-0 DEK
 * and survive elevate(), leaking an elevated record's derived plaintext to any
 * tier-0 caller. Mirrors the forget() → _purgeSearchIndex/_purgeVector
 * precedent, unapplied to elevate.
 *
 * Fixture: `memoryStore()` copied verbatim from `hierarchical-tiers.test.ts`;
 * the stub encoder copied from `embeddings-write.test.ts`. No repo test
 * combines search with `tiers:` prior to this one.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withSearch, ConflictError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
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

const SECRET = 'tiers-search-passphrase-721'

/**
 * A search+tiers harness: `open()` opens a fresh session against the SAME
 * underlying store (simulates a "cold" reopen — new in-memory caches, same
 * ciphertext). `opts.embeddings` adds the stub embeddings descriptor so
 * `put()` derives an encrypted `_vec` sidecar.
 */
function searchHarness(opts: { embeddings?: boolean } = {}) {
  const store = memoryStore()
  async function open() {
    const db = await createNoydb({ store, user: 'owner', secret: SECRET, searchStrategy: withSearch(), tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1],
      perRecordKeys: true,
      textIndexes: ['body'],
      textIndexPersist: true,
      ...(opts.embeddings ? { embeddings: ENCODER } : {}),
    })
    return { db, vault, docs }
  }
  return { store, open }
}

async function openSearch() {
  const h = searchHarness()
  const { docs } = await h.open()
  return { store: h.store, docs }
}

describe('#721 lexical (_ftindex)', () => {
  it('elevate: the persisted _ftindex blob no longer surfaces the elevated record\'s text (warm)', async () => {
    const { store, docs } = await openSearch()
    await docs.put('e1', { id: 'e1', body: 'topsecret-alpha-bravo' })
    await docs.put('t0', { id: 't0', body: 'public-charlie' })
    await docs.retrieve('alpha') // build + persist the index once
    expect(await store.get('v1', '_ftindex', 'docs')).not.toBeNull()

    await docs.elevate('e1', 1)

    // AT-REST GUARANTEE (the crux of this CRITICAL leak): elevate must DELETE
    // the persisted blob synchronously, not merely markDirty the in-memory
    // index. retrieve() self-heals via a rebuild either way, so only a direct
    // store peek — BEFORE any rebuild — can distinguish "blob deleted" from
    // "blob left stale at rest". A future removePersisted→markDirty regression
    // would keep every retrieve() test green while re-opening the leak; this
    // pins it. The blob (decodable under the tier-0 DEK) held e1's verbatim text.
    expect(await store.get('v1', '_ftindex', 'docs')).toBeNull()

    await docs.flushIndex()

    // Public read path: retrieve() must not surface e1 anymore.
    expect((await docs.retrieve('topsecret-alpha-bravo')).map(h => h.id)).toEqual([])
    expect((await docs.retrieve('public-charlie')).map(h => h.id)).toEqual(['t0']) // tier-0 sibling still found
  })

  it('elevate: warm retrieve() in the elevating session no longer returns the record or its snippet', async () => {
    const { docs } = await openSearch()
    await docs.put('e1', { id: 'e1', body: 'topsecret-alpha' })
    await docs.retrieve('alpha') // warms the in-memory index
    await docs.elevate('e1', 1)
    // Pre-#721: warm retrieve returned e1 with a snippet from the index's own text.
    expect((await docs.retrieve('alpha')).map(h => h.id)).toEqual([])
  })

  it('cold session: the elevated record is not in the rebuilt index; tier-0 siblings are', async () => {
    const h = searchHarness()
    const { docs } = await h.open()
    await docs.put('e1', { id: 'e1', body: 'alpha-secret' })
    await docs.put('t0', { id: 't0', body: 'alpha-public' })
    await docs.retrieve('alpha')
    await docs.elevate('e1', 1)

    const cold = await h.open()
    expect((await cold.docs.retrieve('alpha')).map(x => x.id)).toEqual(['t0'])
  })

  it('demote restores lexical searchability', async () => {
    // A single continuous warm index never "forgets" a record on its own
    // (ensureBuilt short-circuits on a defined in-memory index, skipping the
    // fingerprint check) — so to isolate demote's OWN rebuild responsibility
    // from elevate's, open a fresh session with e1 already elevated (its
    // hydration excludes e1 by construction, #701), warm-build the index
    // (confirming exclusion), THEN demote and re-check in the SAME session.
    const h = searchHarness()
    const { docs: setup } = await h.open()
    await setup.put('e1', { id: 'e1', body: 'alpha-secret' })
    await setup.elevate('e1', 1)

    const { docs } = await h.open()
    expect((await docs.retrieve('alpha')).map(x => x.id)).toEqual([]) // sanity: excluded on open

    await docs.demote('e1', 0)
    expect((await docs.retrieve('alpha')).map(x => x.id)).toEqual(['e1'])
  })
})

describe('#721 vector (_vec)', () => {
  it('elevate purges the _vec sidecar; cold semantic retrieve no longer surfaces the record', async () => {
    const h = searchHarness({ embeddings: true })
    const { docs } = await h.open()
    await docs.put('e1', { id: 'e1', body: 'alpha' })
    await docs.put('t0', { id: 't0', body: 'zzzzzzzzzzzzzzzzzzzzz' })
    expect(await h.store.get('v1', '_vec', 'e1')).not.toBeNull()

    const qVec = await ENCODER.encode('alpha')
    // Load the VectorSet into memory BEFORE elevate — otherwise the "warm"
    // assertion below does its first load from the already-purged store and
    // passes even if elevate never dirtied the set (whole-branch review catch:
    // the earlier version of this pin was vacuous). With the set warm, only
    // vectorSet.markDirty() on elevate can evict e1 from the in-memory vectors.
    expect((await docs.similarTo(qVec)).map(x => x.id)).toContain('e1') // warm, pre-elevate

    await docs.elevate('e1', 1)
    expect(await h.store.get('v1', '_vec', 'e1')).toBeNull() // sidecar purged

    // Warm (same-session) eviction: elevate dirtied the VectorSet, so the
    // in-session similarTo rebuilds without e1 — not only the cold reopen below.
    expect((await docs.similarTo(qVec)).map(x => x.id)).not.toContain('e1')

    const cold = await h.open()
    // Pre-#721: cold semantic retrieve/similarTo surfaced e1's id + score with no warm cache.
    expect((await cold.docs.similarTo(qVec)).map(x => x.id)).not.toContain('e1')
    expect((await cold.docs.retrieve('alpha', { mode: 'semantic' })).map(x => x.id)).not.toContain('e1')
  })

  it('demote re-embeds: the record is semantically searchable again', async () => {
    const h = searchHarness({ embeddings: true })
    const { docs } = await h.open()
    await docs.put('e1', { id: 'e1', body: 'alpha' })
    await docs.elevate('e1', 1)
    // Force the precondition demote must handle regardless of elevate's own
    // purge (isolates demote's re-embed responsibility from the elevate test
    // above): the _vec sidecar is gone before demote runs.
    await h.store.delete('v1', '_vec', 'e1')
    await docs.demote('e1', 0)
    expect(await h.store.get('v1', '_vec', 'e1')).not.toBeNull()

    const cold = await h.open()
    const qVec = await ENCODER.encode('alpha')
    expect((await cold.docs.similarTo(qVec)).map(x => x.id)).toContain('e1')
  })
})

describe('#721 defense-in-depth: buildVectorLoad gate', () => {
  it('skips a surviving _vec row whose owning record is elevated', async () => {
    // Simulates a legacy sidecar (written before this fix) or one whose
    // best-effort purge on elevate() failed: elevate() removes the _vec row
    // as usual, then we hand-write it straight back — a survivor Task 1's
    // purge cannot reach. buildVectorLoad must still exclude it by checking
    // the owning record's live tier, not merely trust every _vec row it lists.
    const h = searchHarness({ embeddings: true })
    const { docs } = await h.open()
    await docs.put('leaky', { id: 'leaky', body: 'alpha' })
    const vecRow = await h.store.get('v1', '_vec', 'leaky') // capture a real _vec envelope
    expect(vecRow).not.toBeNull()

    await docs.elevate('leaky', 1) // Task 1 purges it…
    await h.store.put('v1', '_vec', 'leaky', vecRow!) // …simulate a legacy/failed-purge survivor

    const cold = await h.open()
    const qVec = await ENCODER.encode('alpha')
    expect((await cold.docs.similarTo(qVec)).map(x => x.id)).not.toContain('leaky')
  })
})
