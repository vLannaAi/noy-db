/**
 * Stable per-field IDs + generation<->content-hash binding on the
 * persisted schema (#946, Task 1 — data model).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { generateDEK } from '../src/kernel/enclave/index.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { toMemory } from '../../to-memory/src/index.js'
import { coordinatedCutover } from '../src/with-shape/schema-update/index.js'
import { persistSchemaIfNeeded } from '../src/with-shape/persisted-schemas/register.js'
import { loadPersistedSchema, savePersistedSchema, SCHEMAS_COLLECTION } from '../src/with-shape/persisted-schemas/storage.js'
import { loadFence, saveFence } from '../src/with-shape/schema-update/fence.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import type { PersistedSchemaEnvelope } from '../src/with-shape/persisted-schemas/types.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
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
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll() { /* unused */ },
  }
}

describe('PersistedSchemaEnvelope.fieldIds', () => {
  const VAULT = 'acme'
  const COLLECTION = 'invoices'
  let store: NoydbStore
  let dek: CryptoKey

  beforeEach(async () => {
    store = inlineMemory()
    dek = await generateDEK()
  })

  it('mints a distinct base32url token per property on first persist', async () => {
    const Invoice = z.object({ id: z.string(), amount: z.number() })
    const result = await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: Invoice, dek })

    expect(result.envelope.fieldIds).toBeDefined()
    const ids = result.envelope.fieldIds!
    expect(Object.keys(ids).sort()).toEqual(['amount', 'id'])
    for (const id of Object.values(ids)) expect(id).toMatch(/^[a-z2-7]{20}$/)
    expect(ids['id']).not.toBe(ids['amount'])
  })

  it('re-deriving the SAME schema leaves fieldIds byte-identical (no re-mint)', async () => {
    const Invoice = z.object({ id: z.string(), amount: z.number() })
    const first = await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: Invoice, dek })
    const second = await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: Invoice, dek })

    expect(second.written).toBe(false)
    expect(second.skipped).toBe(true)
    expect(second.envelope.fieldIds).toEqual(first.envelope.fieldIds)
  })

  it('adding a field mints a new id while leaving existing ids untouched', async () => {
    const v1 = z.object({ id: z.string(), amount: z.number() })
    const v2 = z.object({ id: z.string(), amount: z.number(), note: z.string() })
    const first = await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: v1, dek })
    const second = await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: v2, dek })

    expect(second.written).toBe(true)
    expect(second.envelope.fieldIds!['id']).toBe(first.envelope.fieldIds!['id'])
    expect(second.envelope.fieldIds!['amount']).toBe(first.envelope.fieldIds!['amount'])
    expect(second.envelope.fieldIds!['note']).toBeDefined()
    expect(second.envelope.fieldIds!['note']).not.toBe(second.envelope.fieldIds!['id'])
  })

  it('a stub (non-Zod) envelope has no derivable field set — fieldIds stays undefined', async () => {
    const fake = { '~standard': { version: 1, vendor: 'valibot', validate: () => ({}) } }
    const result = await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: fake, dek })
    expect(result.envelope.jsonSchema).toBeNull()
    expect(result.envelope.fieldIds).toBeUndefined()
  })
})

describe('generation<->content-hash binding', () => {
  const VAULT = 'acme'
  const COLLECTION = 'invoices'
  let store: NoydbStore
  let dek: CryptoKey

  beforeEach(async () => {
    store = inlineMemory()
    dek = await generateDEK()
  })

  it('stamps envelope.generation from the live fence and binds FenceDoc.schemaHash to the written hash', async () => {
    const v1 = z.object({ id: z.string(), total: z.number() })
    const first = await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: v1, dek })
    expect(first.envelope.generation).toBe(0)

    let fence = await loadFence(store, VAULT)
    expect(fence.currentSchemaVersion).toBe(0)
    expect(fence.schemaHash).toBe(first.envelope.hash)

    // Simulate a vault-wide cutover (elsewhere) bumping the generation —
    // this is exactly what `SchemaFenceController#runCutover` does to
    // `_meta/schema-fence` once the barrier resolves.
    await saveFence(store, VAULT, { currentSchemaVersion: 1, fenceState: 'normal' })

    const v2 = z.object({ id: z.string(), total: z.number(), note: z.string() })
    const second = await persistSchemaIfNeeded({ store, vault: VAULT, collectionName: COLLECTION, validator: v2, dek })
    expect(second.envelope.generation).toBe(1)

    fence = await loadFence(store, VAULT)
    expect(fence.currentSchemaVersion).toBe(1)
    expect(fence.schemaHash).toBe(second.envelope.hash)

    // "Which schema is generation N" is answerable from published reads
    // alone: `schemaFenceState()` (== loadFence) + `loadPersistedSchema`.
    const persisted = await loadPersistedSchema(store, VAULT, COLLECTION, dek)
    expect(persisted!.generation).toBe(fence.currentSchemaVersion)
    expect(fence.schemaHash).toBe(persisted!.hash)
  })

  it('a schemaHash stamp for collection B does not roll back a fence generation advanced concurrently by collection A', async () => {
    // The schemaHash stamp is the FIRST non-barrier writer to
    // `_meta/schema-fence` (previously only SchemaFenceController#setState
    // wrote it, sequentially, under the drain barrier). This reproduces the
    // race: while collection B's persistSchemaIfNeeded is mid-write (between
    // its fence read at entry and its post-write schemaHash stamp),
    // collection A's cutover completes elsewhere and bumps the vault-wide
    // fence. B's stamp must NOT clobber A's advance.
    const base = inlineMemory()
    const dek2 = await generateDEK()
    let armed = false
    const racyStore: NoydbStore = {
      ...base,
      async put(c, col, id, env, ev) {
        await base.put(c, col, id, env, ev)
        if (armed && col === SCHEMAS_COLLECTION && id === 'B') {
          armed = false
          // Simulate collection A's coordinated cutover completing
          // concurrently and bumping the vault-wide generation — exactly
          // what `SchemaFenceController#runCutover` does at barrier-resolve.
          await saveFence(base, VAULT, { currentSchemaVersion: 1, fenceState: 'normal' })
        }
      },
    }

    // Seed collection B's baseline at generation 0.
    await persistSchemaIfNeeded({
      store: racyStore, vault: VAULT, collectionName: 'B', validator: z.object({ id: z.string() }), dek: dek2,
    })

    // Collection B's ordinary re-declare (unrelated to A's cutover) — its
    // internal fence read happens before A's concurrent bump; its post-write
    // schemaHash stamp must re-read the fence rather than reuse that stale
    // snapshot.
    armed = true
    const second = await persistSchemaIfNeeded({
      store: racyStore, vault: VAULT, collectionName: 'B',
      validator: z.object({ id: z.string(), extra: z.number() }), dek: dek2,
    })
    expect(second.written).toBe(true)

    const fence = await loadFence(base, VAULT)
    expect(fence.currentSchemaVersion).toBe(1) // NOT rolled back to 0
    expect(fence.fenceState).toBe('normal')
    expect(fence.schemaHash).toBe(second.envelope.hash) // B's stamp still lands
  })
})

describe('full-vault integration: schemaFenceState() after a real coordinatedCutover', () => {
  const oldS = z.object({ id: z.string(), total: z.number() })
  const newS = z.object({ id: z.string(), amount: z.object({ gross: z.number() }) })
  const transform = (d: Record<string, unknown>) => ({ id: d['id'], amount: { gross: d['total'] } })

  async function open(store: NoydbStore) {
    const db = await createNoydb({ store, user: 'a', secret: 'schema-field-ids-pass-1234' })
    return db.openVault('demo')
  }

  it('generation advances via runSchemaCutover; a later non-gated re-declare persists the migrated schema at the new generation', async () => {
    const store = toMemory()
    let v = await open(store)
    v.collection('invoices', { schema: oldS, persistJsonSchema: true })
    await v._drainPendingSchemaWrites()
    const vBefore = (await store.get('demo', SCHEMAS_COLLECTION, 'invoices'))!._v

    // reopen with the new schema + a coordinatedCutover strategy: the
    // non-additive delta defers the write (old schema stays authoritative
    // until the cutover resolves) and registers a pending cutover instead.
    v = await open(store)
    v.collection('invoices', { schema: newS, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })] })
    await v._drainPendingSchemaWrites()
    await v.runSchemaCutover()

    expect((await v.schemaFenceState()).currentSchemaVersion).toBe(1)
    // The envelope itself is untouched by the cutover machinery — only the
    // record transform ran. `_v` hasn't moved yet.
    expect((await store.get('demo', SCHEMAS_COLLECTION, 'invoices'))!._v).toBe(vBefore)

    // Next declare drops the now-resolved cutover strategy — the ordinary
    // "allow" write path fires and stamps the new (post-cutover) generation.
    v = await open(store)
    v.collection('invoices', { schema: newS, persistJsonSchema: true })
    await v._drainPendingSchemaWrites()

    expect((await store.get('demo', SCHEMAS_COLLECTION, 'invoices'))!._v).toBe(vBefore + 1)
    const fence = await v.schemaFenceState()
    expect(fence.currentSchemaVersion).toBe(1)
    expect(fence.schemaHash).toBeDefined()
  })
})

describe('legacy back-compat (pre-#946 envelopes/fences)', () => {
  it('loadPersistedSchema tolerates an envelope written before fieldIds/generation existed', async () => {
    const store = inlineMemory()
    const dek = await generateDEK()
    const legacy: PersistedSchemaEnvelope = {
      _noydb_schema: 1,
      kind: 'Zod',
      jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
      hash: 'deadbeef',
      derivedAt: new Date().toISOString(),
    }
    await savePersistedSchema(store, 'acme', 'legacy-col', dek, legacy)

    const loaded = await loadPersistedSchema(store, 'acme', 'legacy-col', dek)
    expect(loaded).toBeDefined()
    expect(loaded!.fieldIds).toBeUndefined()
    expect(loaded!.generation).toBeUndefined()
  })

  it('loadFence tolerates a fence doc written before schemaHash existed', async () => {
    const store = inlineMemory()
    await store.put('acme', '_meta', 'schema-fence', {
      _noydb: 1,
      _v: 1,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: JSON.stringify({ currentSchemaVersion: 2, fenceState: 'normal' }),
    })

    const fence = await loadFence(store, 'acme')
    expect(fence).toEqual({ currentSchemaVersion: 2, fenceState: 'normal' })
  })
})
