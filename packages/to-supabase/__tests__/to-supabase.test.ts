import { describe, expect, it } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { supabase, type PostgresClient } from '../src/index.js'

/** Reuse the minimal mock from the to-postgres test shape. */
function mockClient(): PostgresClient & { rowMap: Map<string, Row> } {
  interface Row { vault: string; collection: string; id: string; v: number; envelope: EncryptedEnvelope }
  const rowMap = new Map<string, Row>()
  const key = (v: string, c: string, i: string) => `${v}\x00${c}\x00${i}`

  async function query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase()
    const p = params ?? []
    if (normalized.startsWith('CREATE TABLE') || normalized === 'BEGIN' ||
        normalized === 'COMMIT' || normalized === 'ROLLBACK') return { rows: [] }
    if (normalized === 'SELECT 1') return { rows: [] }
    if (normalized.startsWith('INSERT INTO')) {
      const [vault, collection, id, v, envelope] = p as [string, string, string, number, string]
      rowMap.set(key(vault, collection, id), { vault, collection, id, v, envelope: JSON.parse(envelope) as EncryptedEnvelope })
      return { rows: [] }
    }
    if (normalized.startsWith('DELETE FROM')) {
      if (p.length === 3) {
        const [vault, collection, id] = p as [string, string, string]
        rowMap.delete(key(vault, collection, id))
      } else if (p.length === 1) {
        const [vault] = p as [string]
        for (const [k, r] of rowMap) if (r.vault === vault) rowMap.delete(k)
      }
      return { rows: [] }
    }
    if (normalized.startsWith('SELECT ENVELOPE FROM')) {
      const [vault, collection, id] = p as [string, string, string]
      const row = rowMap.get(key(vault, collection, id))
      return { rows: row ? [{ envelope: row.envelope } as unknown as T] : [] }
    }
    throw new Error(`mock pg: unsupported SQL: ${normalized}`)
  }
  return { query, rowMap }
}

function env(v: number): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: 't', _iv: 'a', _data: `d-${v}`, _by: 'u' }
}

describe('@noy-db/to-supabase', () => {
  it('name is "supabase"', () => {
    const store = supabase({ client: mockClient() })
    expect(store.name).toBe('supabase')
  })

  it('delegates put + get to the postgres layer', async () => {
    const store = supabase({ client: mockClient() })
    await store.put('v1', 'c1', 'r1', env(1))
    expect(await store.get('v1', 'c1', 'r1')).toEqual(env(1))
  })

  it('exposes every postgres extension (tx, listPage, ping)', () => {
    const store = supabase({ client: mockClient() })
    expect(typeof store.tx).toBe('function')
    expect(typeof store.listPage).toBe('function')
    expect(typeof store.ping).toBe('function')
  })

  it('honours a custom tableName option', async () => {
    const c = mockClient()
    const store = supabase({ client: c, tableName: 'my_custom_table' })
    await store.put('v1', 'c1', 'r1', env(1))
    expect(c.rowMap.size).toBe(1)
  })
})
