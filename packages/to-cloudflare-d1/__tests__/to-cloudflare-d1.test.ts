import { describe, expect, it, beforeEach } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { d1, type D1Database, type D1PreparedStatement, type D1Result } from '../src/index.js'

function mockD1(): D1Database & { rowMap: Map<string, Row> } {
  interface Row {
    vault: string; collection: string; id: string; v: number; ts: string; iv: string; data: string
    by: string | null; tier: number | null; elevated_by: string | null; det: string | null
  }
  const rowMap = new Map<string, Row>()
  const key = (v: string, c: string, i: string) => `${v}\x00${c}\x00${i}`

  function dispatch(sql: string, args: readonly unknown[]) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase()
    if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('CREATE INDEX')) return { results: [] }
    if (normalized === 'SELECT 1') return { results: [{ '1': 1 }] }
    if (normalized.startsWith('INSERT INTO')) {
      const [vault, collection, id, v, ts, iv, data, by, tier, elevated_by, det] = args as [
        string, string, string, number, string, string, string, string | null, number | null, string | null, string | null,
      ]
      rowMap.set(key(vault, collection, id), { vault, collection, id, v, ts, iv, data, by, tier, elevated_by, det })
      return { results: [] }
    }
    if (normalized.startsWith('DELETE FROM')) {
      if (args.length === 3) {
        const [vault, collection, id] = args as [string, string, string]
        rowMap.delete(key(vault, collection, id))
      } else if (args.length === 1) {
        const [vault] = args as [string]
        for (const [k, r] of rowMap) if (r.vault === vault) rowMap.delete(k)
      }
      return { results: [] }
    }
    if (normalized.startsWith('SELECT V FROM')) {
      const [vault, collection, id] = args as [string, string, string]
      const row = rowMap.get(key(vault, collection, id))
      return { results: row ? [{ v: row.v }] : [] }
    }
    if (normalized.startsWith('SELECT ID FROM')) {
      const [vault, collection] = args as [string, string]
      return {
        results: [...rowMap.values()]
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
      return { results: matched }
    }
    if (normalized.startsWith('SELECT * FROM')) {
      if (args.length === 3) {
        const [vault, collection, id] = args as [string, string, string]
        const row = rowMap.get(key(vault, collection, id))
        return { results: row ? [row] : [] }
      }
      const [vault] = args as [string]
      return { results: [...rowMap.values()].filter(r => r.vault === vault) }
    }
    throw new Error(`mock d1: unsupported SQL: ${normalized}`)
  }

  function prepare(sql: string): D1PreparedStatement {
    let boundArgs: readonly unknown[] = []
    const stmt: D1PreparedStatement = {
      bind(...args: readonly unknown[]) { boundArgs = args; return stmt },
      async first<T>() { const r = dispatch(sql, boundArgs); return (r.results[0] ?? null) as T | null },
      async all<T>() { return { results: dispatch(sql, boundArgs).results as T[], success: true } as D1Result<T> },
      async run<T>() { return { results: dispatch(sql, boundArgs).results as T[], success: true } as D1Result<T> },
    }
    return stmt
  }

  async function batch<T>(statements: readonly D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const out: D1Result<T>[] = []
    for (const s of statements) out.push(await s.run<T>())
    return out
  }

  return { prepare, batch, rowMap }
}

function env(v: number): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(), _iv: 'aaaa', _data: `ct-${v}`, _by: 'alice' }
}

describe('@noy-db/to-cloudflare-d1', () => {
  let db: ReturnType<typeof mockD1>
  let store: ReturnType<typeof d1>
  beforeEach(() => {
    db = mockD1()
    store = d1({ db })
  })

  it('name is "cloudflare-d1"', () => expect(store.name).toBe('cloudflare-d1'))

  it('put + get round-trip', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    expect(await store.get('v1', 'c1', 'r1')).toEqual(env(1))
  })

  it('get returns null when missing', async () => {
    expect(await store.get('v1', 'c1', 'nope')).toBeNull()
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

  it('saveAll replaces vault contents via batch', async () => {
    await store.put('v1', 'c1', 'old', env(1))
    await store.saveAll('v1', { c1: { new: env(9) } })
    expect(await store.get('v1', 'c1', 'old')).toBeNull()
    expect(await store.get('v1', 'c1', 'new')).toEqual(env(9))
  })

  it('listPage uses keyset paging', async () => {
    for (const id of ['r1', 'r2', 'r3', 'r4']) await store.put('v1', 'c1', id, env(1))
    const p1 = await store.listPage!('v1', 'c1', undefined, 2)
    expect(p1.items.map(x => x.id)).toEqual(['r1', 'r2'])
    const p2 = await store.listPage!('v1', 'c1', p1.nextCursor!, 2)
    expect(p2.items.map(x => x.id)).toEqual(['r3', 'r4'])
    expect(p2.nextCursor).toBeNull()
  })

  it('tx batches ops via d1.batch()', async () => {
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
