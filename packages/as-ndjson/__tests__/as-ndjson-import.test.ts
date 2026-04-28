import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { fromString } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const comp = store.get(v); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        s[n] = r
      }
      return s
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(v, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Note { id: string; text: string }

async function setup() {
  const adapter = memory()
  const init = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
  await init.openVault('demo')
  await init.grant('demo', {
    userId: 'alice', displayName: 'Alice', role: 'owner',
    passphrase: 'pw-2026',
    importCapability: { plaintext: ['ndjson'] },
  })
  init.close()
  const db = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
  const vault = await db.openVault('demo')
  const notes = vault.collection<Note>('notes')
  await notes.put('a', { id: 'a', text: 'hello' })
  return { db, vault }
}

describe('as-ndjson fromString', () => {
  it('parses one record per line and applies under merge policy', async () => {
    const { db, vault } = await setup()
    const ndjson = [
      '{"id":"a","text":"hello (updated)"}',
      '',
      '{"id":"b","text":"second"}',
      '   ',                            // whitespace-only — ignored
      '{"id":"c","text":"third"}',
    ].join('\n')

    const importer = await fromString(vault, ndjson, { collection: 'notes' })
    expect(importer.plan.summary).toEqual({ add: 2, modify: 1, delete: 0, total: 3 })

    await importer.apply()

    const notes = vault.collection<Note>('notes')
    expect(await notes.get('a')).toEqual({ id: 'a', text: 'hello (updated)' })
    expect(await notes.get('b')).toEqual({ id: 'b', text: 'second' })
    expect(await notes.get('c')).toEqual({ id: 'c', text: 'third' })
    db.close()
  })

  it('reports the line number on a malformed record', async () => {
    const { db, vault } = await setup()
    const ndjson = '{"id":"a"}\n{ invalid }'
    await expect(
      fromString(vault, ndjson, { collection: 'notes' }),
    ).rejects.toThrow(/line 2/)
    db.close()
  })

  it('rejects non-object lines (arrays, primitives)', async () => {
    const { db, vault } = await setup()
    await expect(
      fromString(vault, '[1,2,3]', { collection: 'notes' }),
    ).rejects.toThrow(/not a JSON object/)
    db.close()
  })
})
