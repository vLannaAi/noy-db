/**
 * #657 finding 1 — `blobFields` are invisible in `describe()` (or, with a
 * `fieldMeta` entry, described as an editable `type:'unknown'` text field).
 * Repros adapted from the issue (published-package imports → workspace
 * imports). Fix routes through the ESTABLISHED `describeFragment()` door
 * (the `lookup` binding is the reference implementation) — the `'blob'`
 * binding's fragment now feeds `buildDescription`'s `allKeys` union AND a
 * dedicated `blob` block, mirroring the `lookup` block's own wiring.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withBlobs } from '../../src/via/blob/active.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c)
      const s: VaultSnapshot = {}
      if (comp) {
        for (const [n, coll] of comp) {
          if (!n.startsWith('_')) {
            const r: Record<string, EncryptedEnvelope> = {}
            for (const [id, e] of coll) r[id] = e
            s[n] = r
          }
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

describe('#657 — blobFields describe() fidelity', () => {
  it('a bare blobFields field (no fieldMeta) now APPEARS in describe({})', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'u', secret: 'pw-blob-1', blobStrategy: withBlobs() })
    const vault = await db.openVault('v')
    const a = vault.collection('a', { blobFields: { cover: { retainDays: 10 } } })

    const keys = (await a.describe({})).fields.map((f) => f.key)
    expect(keys).toContain('cover')
  })

  it('a bare blobFields field: honest type/widget/editable/blob block (async describe)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'u', secret: 'pw-blob-2', blobStrategy: withBlobs() })
    const vault = await db.openVault('v')
    const a = vault.collection('a', { blobFields: { cover: { retainDays: 10 } } })

    const cover = (await a.describe({})).fields.find((f) => f.key === 'cover')!
    expect(cover.type).toBe('blob')
    expect(cover.widget).not.toBe('text')
    expect(cover.widget).toBe('file')
    expect(cover.editable).toBe(false)
    expect(cover.blob).toEqual({ retainDays: 10, queryable: 'none' })
  })

  it('blobFields + fieldMeta: label is preserved, but the shape is honest (not unknown/text/editable)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'u', secret: 'pw-blob-3', blobStrategy: withBlobs() })
    const vault = await db.openVault('v')
    const b = vault.collection('b', {
      blobFields: { cover: { retainDays: 10 } },
      fieldMeta: { cover: { label: 'Cover' } },
    })

    const cover = (await b.describe({})).fields.find((f) => f.key === 'cover')!
    expect(cover.label).toBe('Cover')
    expect(cover.type).toBe('blob')
    expect(cover.widget).not.toBe('text')
    expect(cover.editable).toBe(false)
    expect(cover.blob).toEqual({ retainDays: 10, queryable: 'none' })
  })

  it('predicate knobs (evictWhen/legalHold/retainUntil) surface as presence flags on the blob block', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'u', secret: 'pw-blob-4', blobStrategy: withBlobs() })
    const vault = await db.openVault('v')
    const c = vault.collection('c', {
      blobFields: {
        scan: { legalHold: () => true, retainUntil: () => null, public: true },
      },
    })

    const scan = (await c.describe({})).fields.find((f) => f.key === 'scan')!
    expect(scan.blob).toEqual({ legalHold: true, retainUntil: true, public: true, queryable: 'none' })
  })

  it('sync describe() (no store I/O) also surfaces a bare blobFields field', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'u', secret: 'pw-blob-5', blobStrategy: withBlobs() })
    const vault = await db.openVault('v')
    const a = vault.collection('a', { blobFields: { cover: { retainDays: 10 } } })

    const cover = a.describe().fields.find((f) => f.key === 'cover')
    expect(cover).toBeDefined()
    expect(cover!.type).toBe('blob')
    expect(cover!.editable).toBe(false)
  })

  // Regression (mirrors the i18nFields precedent in describe.test.ts): a
  // blobFields field paired with fieldMeta but declared alongside a REAL
  // zod schema (covering other fields) must not trip the async
  // fieldMeta-key-validation gate — 'cover' is legitimately unknown to the
  // schema (blob content never flows the record codec) but IS known via
  // blobFields.
  it('async describe does not throw when a field is in both blobFields and fieldMeta but not the zod schema', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'u', secret: 'pw-blob-6', blobStrategy: withBlobs() })
    const vault = await db.openVault('v')
    const d = vault.collection('d', {
      schema: z.object({ id: z.string(), title: z.string() }) as unknown as import('../../src/kernel/schema.js').StandardSchemaV1,
      blobFields: { cover: { retainDays: 10 } },
      fieldMeta: { cover: { label: 'Cover' } },
    })

    const desc = await d.describe({})
    const cover = desc.fields.find((f) => f.key === 'cover')!
    expect(cover.label).toBe('Cover')
    expect(cover.type).toBe('blob')
  })
})
