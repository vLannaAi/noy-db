import { describe, expect, it, beforeEach } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { sqlite, type SqliteDatabase, type SqliteStatement } from '../src/index.js'

/**
 * In-memory mock of the duck-typed `SqliteDatabase` interface.
 *
 * Parses just enough of the SQL we emit to answer `get/all/run` —
 * NOT a general SQL engine. Mirrors the shape of the real store's
 * queries so every CRUD path is exercised without a native binary.
 */
function mockDb(): SqliteDatabase & { rows: Map<string, Row> } {
  interface Row {
    vault: string; collection: string; id: string; v: number; ts: string; iv: string; data: string
    by: string | null; tier: number | null; elevated_by: string | null; det: string | null
  }
  const rows = new Map<string, Row>()
  const key = (v: string, c: string, i: string) => `${v}\x00${c}\x00${i}`

  function stmt(sql: string): SqliteStatement {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    return {
      run(...params: readonly unknown[]) {
        if (/^INSERT INTO/i.test(normalized)) {
          const [vault, collection, id, v, ts, iv, data, by, tier, elevated_by, det] = params as [
            string, string, string, number, string, string, string, string | null, number | null, string | null, string | null,
          ]
          rows.set(key(vault, collection, id), { vault, collection, id, v, ts, iv, data, by, tier, elevated_by, det })
          return { changes: 1 }
        }
        if (/^DELETE FROM/i.test(normalized)) {
          // DELETE FROM t WHERE vault = ? AND (collection = ? (AND id = ?)?)?
          if (params.length === 3) {
            const [vault, collection, id] = params as [string, string, string]
            rows.delete(key(vault, collection, id))
            return { changes: 1 }
          }
          if (params.length === 1) {
            // DELETE FROM t WHERE vault = ?
            const [vault] = params as [string]
            for (const [k, row] of rows) if (row.vault === vault) rows.delete(k)
            return { changes: 1 }
          }
          return { changes: 0 }
        }
        if (/^SELECT 1/i.test(normalized)) return { changes: 0 }
        throw new Error(`mockDb.run: unsupported SQL: ${normalized}`)
      },
      get(...params: readonly unknown[]) {
        if (/^SELECT 1/i.test(normalized)) return { '1': 1 }
        if (/WHERE vault = \? AND collection = \? AND id = \?/i.test(normalized)) {
          const [vault, collection, id] = params as [string, string, string]
          const row = rows.get(key(vault, collection, id))
          if (!row) return undefined
          if (/^SELECT v FROM/i.test(normalized)) return { v: row.v }
          return row
        }
        throw new Error(`mockDb.get: unsupported SQL: ${normalized}`)
      },
      all(...params: readonly unknown[]) {
        if (/^SELECT id FROM/i.test(normalized)) {
          const [vault, collection] = params as [string, string]
          return [...rows.values()]
            .filter(r => r.vault === vault && r.collection === collection)
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(r => ({ id: r.id }))
        }
        if (/^SELECT \* FROM .* WHERE vault = \? AND collection = \? ORDER BY id LIMIT \? OFFSET \?/i.test(normalized) ||
            /^SELECT id, v, ts, iv, data, by, tier, elevated_by, det FROM/i.test(normalized)) {
          const [vault, collection, limit, offset] = params as [string, string, number, number]
          return [...rows.values()]
            .filter(r => r.vault === vault && r.collection === collection)
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(offset, offset + limit)
        }
        if (/^SELECT \* FROM .* WHERE vault = \?/i.test(normalized)) {
          const [vault] = params as [string]
          return [...rows.values()].filter(r => r.vault === vault)
        }
        throw new Error(`mockDb.all: unsupported SQL: ${normalized}`)
      },
    }
  }

  return {
    prepare: stmt,
    exec() {
      // Table DDL + transaction ctrl are no-ops in the mock.
    },
    rows,
  }
}

function env(v: number, iv = 'aaaa'): EncryptedEnvelope {
  return {
    _noydb: 1,
    _v: v,
    _ts: new Date(1700000000000 + v * 1000).toISOString(),
    _iv: iv,
    _data: `ciphertext-${v}`,
    _by: 'alice',
  }
}

describe('@noy-db/to-sqlite', () => {
  let db: ReturnType<typeof mockDb>
  let store: ReturnType<typeof sqlite>
  beforeEach(() => {
    db = mockDb()
    store = sqlite({ db })
  })

  it('name is "sqlite"', () => {
    expect(store.name).toBe('sqlite')
  })

  it('put + get round-trip preserves envelope', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    expect(await store.get('v1', 'c1', 'r1')).toEqual(env(1))
  })

  it('get returns null for missing records', async () => {
    expect(await store.get('v1', 'c1', 'nope')).toBeNull()
  })

  it('preserves _tier / _elevatedBy / _det metadata fields', async () => {
    const envelope: EncryptedEnvelope = {
      ...env(1),
      _tier: 2,
      _elevatedBy: 'bob',
      _det: { email: 'abc:def' },
    }
    await store.put('v1', 'c1', 'r1', envelope)
    const out = await store.get('v1', 'c1', 'r1')
    expect(out).toEqual(envelope)
  })

  it('list returns sorted ids', async () => {
    await store.put('v1', 'c1', 'b', env(1))
    await store.put('v1', 'c1', 'a', env(1))
    await store.put('v1', 'c1', 'c', env(1))
    expect(await store.list('v1', 'c1')).toEqual(['a', 'b', 'c'])
  })

  it('delete removes the record', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await store.delete('v1', 'c1', 'r1')
    expect(await store.get('v1', 'c1', 'r1')).toBeNull()
  })

  it('expectedVersion match allows the put', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await expect(store.put('v1', 'c1', 'r1', env(2), 1)).resolves.toBeUndefined()
  })

  it('expectedVersion mismatch throws ConflictError with .version', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    try {
      await store.put('v1', 'c1', 'r1', env(2), 999)
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError)
      expect((err as ConflictError).version).toBe(1)
    }
  })

  it('loadAll groups envelopes by collection', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await store.put('v1', 'c2', 'r2', env(1))
    const snap = await store.loadAll('v1')
    expect(Object.keys(snap).sort()).toEqual(['c1', 'c2'])
    expect(snap.c1!.r1).toEqual(env(1))
  })

  it('saveAll replaces vault contents atomically', async () => {
    await store.put('v1', 'c1', 'old', env(1))
    await store.saveAll('v1', { c1: { new: env(5) } })
    expect(await store.get('v1', 'c1', 'old')).toBeNull()
    expect(await store.get('v1', 'c1', 'new')).toEqual(env(5))
  })

  it('listPage paginates ordered ids', async () => {
    for (let i = 0; i < 5; i++) await store.put('v1', 'c1', `r${i}`, env(1))
    const page1 = await store.listPage!('v1', 'c1', undefined, 2)
    expect(page1.items.map(x => x.id)).toEqual(['r0', 'r1'])
    expect(page1.nextCursor).toBe('2')
    const page2 = await store.listPage!('v1', 'c1', page1.nextCursor!, 2)
    expect(page2.items.map(x => x.id)).toEqual(['r2', 'r3'])
    expect(page2.nextCursor).toBe('4')
    const page3 = await store.listPage!('v1', 'c1', page2.nextCursor!, 2)
    expect(page3.items.map(x => x.id)).toEqual(['r4'])
    expect(page3.nextCursor).toBeNull()
  })

  it('tx commits every op as a batch', async () => {
    await store.tx!([
      { type: 'put', vault: 'v1', collection: 'c1', id: 'a', envelope: env(1) },
      { type: 'put', vault: 'v1', collection: 'c1', id: 'b', envelope: env(2) },
    ])
    expect(await store.list('v1', 'c1')).toEqual(['a', 'b'])
  })

  it('ping returns true for a live database', async () => {
    expect(await store.ping!()).toBe(true)
  })
})
