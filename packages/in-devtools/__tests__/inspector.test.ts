import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '@noy-db/hub'
import type { Noydb, NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { createInspector } from '../src/index.js'

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const coll = (v: string, c: string) => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const m = coll(v, c); const ex = m.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      m.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async listVaults() { return [...data.keys()] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll() {},
  }
}

interface Note { id: string; title: string; body: string }

async function seeded(): Promise<{ db: Noydb }> {
  const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
  const v = await db.openVault('v1')
  const notes = v.collection<Note>('notes')
  await notes.put('a', { id: 'a', title: 'A', body: 'first' })
  await notes.put('b', { id: 'b', title: 'B', body: 'second' })
  return { db }
}

describe('inspector — listVaults + snapshot', () => {
  it('listVaults returns accessible vaults', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const vaults = await insp.listVaults()
    expect(vaults.some((x) => x.id === 'v1')).toBe(true)
  })

  it('snapshot returns the collection with stats', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const v = await db.openVault('v1')
    const snap = await insp.snapshot(v)
    expect(snap.vault).toBe('v1')
    const notes = snap.collections.find((c) => c.name === 'notes')
    expect(notes).toBeTruthy()
    expect(notes!.stats?.records).toBe(2)
  })
})

describe('inspector — records', () => {
  it('returns a bounded page with an accurate total', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const v = await db.openVault('v1')
    const page = await insp.records(v, 'notes', { limit: 1, offset: 0 })
    expect(page.total).toBe(2)
    expect(page.rows).toHaveLength(1)
    expect(page.limit).toBe(1)
    expect(page.offset).toBe(0)
  })

  it('clamps limit to the hard ceiling and floors a bad offset to 0', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const v = await db.openVault('v1')
    const page = await insp.records(v, 'notes', { limit: 99999, offset: -5 })
    expect(page.limit).toBe(500) // MAX_LIMIT
    expect(page.offset).toBe(0)
    expect(page.rows).toHaveLength(2)
  })
})

describe('inspector — subscribe + pendingWrites', () => {
  it('subscribe fires on put (create) and unsubscribe stops it', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const seen: Array<{ op: string; collection: string; docId: string }> = []
    const off = insp.subscribe((e) => { seen.push({ op: e.op, collection: e.collection, docId: e.docId }) })

    const v = await db.openVault('v1')
    await v.collection<Note>('notes').put('c', { id: 'c', title: 'C', body: 'third' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ op: 'create', collection: 'notes', docId: 'c' })

    off()
    await v.collection<Note>('notes').put('d', { id: 'd', title: 'D', body: 'fourth' })
    expect(seen).toHaveLength(1) // no further events after unsubscribe
  })

  it('subscribe fires on delete with after:null', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const seen: Array<{ op: string; after: unknown }> = []
    insp.subscribe((e) => { seen.push({ op: e.op, after: e.after }) })
    const v = await db.openVault('v1')
    await v.collection<Note>('notes').delete('a')
    expect(seen).toEqual([{ op: 'delete', after: null }])
  })

  it('pendingWrites reflects the write queue', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const pw = insp.pendingWrites()
    expect(pw.pending).toBe(false)
    expect(typeof pw.depth).toBe('number')
  })

  it('read-only: inspecting does not mutate the store', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const v = await db.openVault('v1')
    await insp.listVaults()
    await insp.snapshot(v)
    await insp.records(v, 'notes')
    insp.pendingWrites()
    const after = await insp.records(v, 'notes')
    expect(after.total).toBe(2) // unchanged
  })
})
