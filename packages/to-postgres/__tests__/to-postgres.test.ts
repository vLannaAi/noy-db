import { describe, expect, it, beforeEach } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { postgres, type PostgresClient } from '../src/index.js'

/**
 * In-memory mock of a pg-style Client. Parses the small set of SQL
 * patterns the store emits and answers from a Map.
 */
function mockClient(): PostgresClient & { rows: Map<string, Row> } {
  interface Row { vault: string; collection: string; id: string; v: number; envelope: EncryptedEnvelope }
  const rows = new Map<string, Row>()
  const key = (v: string, c: string, i: string) => `${v}\x00${c}\x00${i}`
  let inTx = false
  let txSnapshot: Map<string, Row> | null = null

  async function query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase()
    const p = params ?? []

    if (normalized.startsWith('CREATE TABLE')) return { rows: [] }
    if (normalized === 'BEGIN') {
      inTx = true
      txSnapshot = new Map(rows)
      return { rows: [] }
    }
    if (normalized === 'COMMIT') { inTx = false; txSnapshot = null; return { rows: [] } }
    if (normalized === 'ROLLBACK') {
      if (txSnapshot) {
        rows.clear()
        for (const [k, v] of txSnapshot) rows.set(k, v)
      }
      inTx = false; txSnapshot = null
      return { rows: [] }
    }
    if (normalized === 'SELECT 1') return { rows: [{ '?column?': 1 } as unknown as T] }

    if (normalized.startsWith('INSERT INTO')) {
      const [vault, collection, id, v, envelope] = p as [string, string, string, number, string]
      rows.set(key(vault, collection, id), {
        vault, collection, id, v,
        envelope: JSON.parse(envelope) as EncryptedEnvelope,
      })
      return { rows: [] }
    }
    if (normalized.startsWith('DELETE FROM')) {
      if (p.length === 3) {
        const [vault, collection, id] = p as [string, string, string]
        rows.delete(key(vault, collection, id))
      } else if (p.length === 1) {
        const [vault] = p as [string]
        for (const [k, r] of rows) if (r.vault === vault) rows.delete(k)
      }
      return { rows: [] }
    }
    if (normalized.startsWith('SELECT ENVELOPE FROM')) {
      const [vault, collection, id] = p as [string, string, string]
      const row = rows.get(key(vault, collection, id))
      return { rows: row ? [{ envelope: row.envelope } as unknown as T] : [] }
    }
    if (normalized.startsWith('SELECT V FROM')) {
      const [vault, collection, id] = p as [string, string, string]
      const row = rows.get(key(vault, collection, id))
      return { rows: row ? [{ v: row.v } as unknown as T] : [] }
    }
    if (normalized.startsWith('SELECT ID FROM')) {
      const [vault, collection] = p as [string, string]
      const ids = [...rows.values()]
        .filter(r => r.vault === vault && r.collection === collection)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(r => ({ id: r.id }))
      return { rows: ids as unknown as T[] }
    }
    if (normalized.includes('FROM') && normalized.includes('WHERE VAULT = $1 AND COLLECTION = $2 AND ID > $3')) {
      const [vault, collection, afterId, limit] = p as [string, string, string, number]
      const matched = [...rows.values()]
        .filter(r => r.vault === vault && r.collection === collection && r.id > afterId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map(r => ({ id: r.id, envelope: r.envelope }))
      return { rows: matched as unknown as T[] }
    }
    if (normalized.startsWith('SELECT ID, COLLECTION, V, ENVELOPE FROM')) {
      const [vault] = p as [string]
      const matched = [...rows.values()]
        .filter(r => r.vault === vault)
        .map(r => ({ id: r.id, collection: r.collection, v: r.v, envelope: r.envelope }))
      return { rows: matched as unknown as T[] }
    }
    void inTx
    throw new Error(`mock pg: unsupported SQL: ${normalized}`)
  }

  return { query, rows }
}

function env(v: number): EncryptedEnvelope {
  return {
    _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: 'aaaa', _data: `ciphertext-${v}`, _by: 'alice',
  }
}

describe('@noy-db/to-postgres', () => {
  let client: ReturnType<typeof mockClient>
  let store: ReturnType<typeof postgres>
  beforeEach(() => {
    client = mockClient()
    store = postgres({ client })
  })

  it('name is "postgres"', () => {
    expect(store.name).toBe('postgres')
  })

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
    expect(snap.c1!.r1).toEqual(env(1))
  })

  it('saveAll replaces vault contents', async () => {
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

  it('tx batches ops in a transaction', async () => {
    await store.tx!([
      { type: 'put', vault: 'v1', collection: 'c1', id: 'a', envelope: env(1) },
      { type: 'put', vault: 'v1', collection: 'c1', id: 'b', envelope: env(2) },
    ])
    expect(await store.list('v1', 'c1')).toEqual(['a', 'b'])
  })

  it('ping returns true for a live connection', async () => {
    expect(await store.ping!()).toBe(true)
  })
})
