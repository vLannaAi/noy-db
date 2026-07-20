/**
 * #308 L1 — blob filename indexing in collection.retrieve().
 * Blob slot metadata lives in a separate `_blob_slots_*` collection and is read
 * via an async per-record `collection.blob(id).list()` (returns SlotInfo[] with
 * `.name` = slot/field name and `.filename` = user-visible filename). When a
 * blob field is named in `textIndexes`, its slot filenames must be searchable.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSearch } from '../src/index.js'
import { withBlobs } from '../src/via/blob/index.js'
import { ConflictError } from '../src/kernel/errors.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
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
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) {
        const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r
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

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

interface Doc { id: string; ref: string }

describe('retrieve() indexes blob filenames (#308 L1)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-search-blob-long-enough', blobStrategy: withBlobs(), searchStrategy: withSearch() })
  })

  it('finds a record by its attached blob filename', async () => {
    const vault = await db.openVault('v')
    const docs = vault.collection<Doc>('docs', {
      prefetch: true,
      textIndexes: ['attachment'],
      blobFields: { attachment: {} },
    })

    await docs.put('d-001', { id: 'd-001', ref: 'R1' })
    await docs.put('d-002', { id: 'd-002', ref: 'R2' })

    // Attach a blob into the `attachment` slot with a known filename.
    await docs.blob('d-001').put('attachment', textBytes('pdf bytes'), { filename: 'invoice-2024.pdf' })
    await docs.blob('d-002').put('attachment', textBytes('pdf bytes 2'), { filename: 'receipt-2024.pdf' })

    const hits = await docs.retrieve('invoice')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.id).toBe('d-001')
    expect(hits[0]!.field).toBe('attachment')

    db.close()
  })

  it('does no slot I/O when no indexed field is a blob field', async () => {
    const vault = await db.openVault('v')
    const docs = vault.collection<Doc>('docs', {
      prefetch: true,
      textIndexes: ['ref'],
    })
    await docs.put('d-001', { id: 'd-001', ref: 'plain text only' })

    const hits = await docs.retrieve('plain')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.field).toBe('ref')

    db.close()
  })
})
