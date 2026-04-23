import { describe, expect, it, beforeEach } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { turso, type LibsqlClient } from '../src/index.js'

function mockLibsql(): LibsqlClient & { rowMap: Map<string, Row> } {
  interface Row {
    vault: string; collection: string; id: string; v: number; ts: string; iv: string; data: string
    by: string | null; tier: number | null; elevated_by: string | null; det: string | null
  }
  const rowMap = new Map<string, Row>()
  const key = (v: string, c: string, i: string) => `${v}\x00${c}\x00${i}`

  function handle(sql: string, args: readonly unknown[]) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase()
    if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('CREATE INDEX')) return { rows: [] }
    if (normalized === 'SELECT 1') return { rows: [{ '1': 1 }] }
    if (normalized.startsWith('INSERT INTO')) {
      const [vault, collection, id, v, ts, iv, data, by, tier, elevated_by, det] = args as [
        string, string, string, number, string, string, string, string | null, number | null, string | null, string | null,
      ]
      rowMap.set(key(vault, collection, id), { vault, collection, id, v, ts, iv, data, by, tier, elevated_by, det })
      return { rows: [] }
    }
    if (normalized.startsWith('DELETE FROM')) {
      if (args.length === 3) {
        const [vault, collection, id] = args as [string, string, string]
        rowMap.delete(key(vault, collection, id))
      } else if (args.length === 1) {
        const [vault] = args as [string]
        for (const [k, r] of rowMap) if (r.vault === vault) rowMap.delete(k)
      }
      return { rows: [] }
    }
    if (normalized.startsWith('SELECT V FROM')) {
      const [vault, collection, id] = args as [string, string, string]
      const row = rowMap.get(key(vault, collection, id))
      return { rows: row ? [{ v: row.v }] : [] }
    }
    if (normalized.startsWith('SELECT ID FROM')) {
      const [vault, collection] = args as [string, string]
      return {
        rows: [...rowMap.values()]
          .filter(r => r.vault === vault && r.collection === collection)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(r => ({ id: r.id })),
      }
    }
    if (normalized.startsWith('SELECT ID, V, TS, IV, DATA, BY, TIER, ELEVATED_BY, DET FROM')) {
      const [vault, collection, afterId, limit] = args as [string, string, string, number]
      const matched = [...rowMap.values()]
        .filter(r => r.vault === vault && r.collection === collection && r.id > afterId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
      return { rows: matched }
    }
    if (normalized.startsWith('SELECT * FROM')) {
      if (args.length === 3) {
        const [vault, collection, id] = args as [string, string, string]
        const row = rowMap.get(key(vault, collection, id))
        return { rows: row ? [row] : [] }
      }
      const [vault] = args as [string]
      return { rows: [...rowMap.values()].filter(r => r.vault === vault) }
    }
    throw new Error(`mock libsql: unsupported SQL: ${normalized}`)
  }

  return {
    async execute(arg) {
      if (typeof arg === 'string') return handle(arg, [])
      return handle(arg.sql, arg.args ?? [])
    },
    async batch(statements) {
      const results = []
      for (const s of statements) results.push(handle(s.sql, s.args ?? []))
      return results
    },
    rowMap,
  }
}

function env(v: number): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(), _iv: 'aaaa', _data: `ct-${v}`, _by: 'alice' }
}

describe('@noy-db/to-turso', () => {
  let client: ReturnType<typeof mockLibsql>
  let store: ReturnType<typeof turso>
  beforeEach(() => {
    client = mockLibsql()
    store = turso({ client })
  })

  it('name is "turso"', () => expect(store.name).toBe('turso'))

  it('put + get round-trip', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    expect(await store.get('v1', 'c1', 'r1')).toEqual(env(1))
  })

  it('get returns null when missing', async () => {
    expect(await store.get('v1', 'c1', 'nope')).toBeNull()
  })

  it('preserves _tier / _elevatedBy / _det', async () => {
    const envelope: EncryptedEnvelope = { ...env(1), _tier: 2, _elevatedBy: 'bob', _det: { email: 'abc:def' } }
    await store.put('v1', 'c1', 'r1', envelope)
    expect(await store.get('v1', 'c1', 'r1')).toEqual(envelope)
  })

  it('list returns sorted ids', async () => {
    await store.put('v1', 'c1', 'b', env(1))
    await store.put('v1', 'c1', 'a', env(1))
    expect(await store.list('v1', 'c1')).toEqual(['a', 'b'])
  })

  it('delete removes', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await store.delete('v1', 'c1', 'r1')
    expect(await store.get('v1', 'c1', 'r1')).toBeNull()
  })

  it('expectedVersion match succeeds', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await expect(store.put('v1', 'c1', 'r1', env(2), 1)).resolves.toBeUndefined()
  })

  it('expectedVersion mismatch throws ConflictError', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await expect(store.put('v1', 'c1', 'r1', env(2), 999)).rejects.toBeInstanceOf(ConflictError)
  })

  it('loadAll groups by collection', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await store.put('v1', 'c2', 'r2', env(1))
    const snap = await store.loadAll('v1')
    expect(Object.keys(snap).sort()).toEqual(['c1', 'c2'])
  })

  it('saveAll replaces vault contents (batch)', async () => {
    await store.put('v1', 'c1', 'old', env(1))
    await store.saveAll('v1', { c1: { new: env(9) } })
    expect(await store.get('v1', 'c1', 'old')).toBeNull()
    expect(await store.get('v1', 'c1', 'new')).toEqual(env(9))
  })

  it('listPage uses keyset paging', async () => {
    for (const id of ['r1', 'r2', 'r3', 'r4']) await store.put('v1', 'c1', id, env(1))
    const p1 = await store.listPage!('v1', 'c1', undefined, 2)
    expect(p1.items.map(x => x.id)).toEqual(['r1', 'r2'])
    expect(p1.nextCursor).toBe('r2')
    const p2 = await store.listPage!('v1', 'c1', p1.nextCursor!, 2)
    expect(p2.items.map(x => x.id)).toEqual(['r3', 'r4'])
    expect(p2.nextCursor).toBeNull()
  })

  it('tx batches ops via client.batch()', async () => {
    await store.tx!([
      { type: 'put', vault: 'v1', collection: 'c1', id: 'a', envelope: env(1) },
      { type: 'put', vault: 'v1', collection: 'c1', id: 'b', envelope: env(2) },
    ])
    expect(await store.list('v1', 'c1')).toEqual(['a', 'b'])
  })

  it('ping returns true', async () => {
    expect(await store.ping!()).toBe(true)
  })
})
