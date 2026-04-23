/**
 * **@noy-db/to-turso** — Turso / libSQL adapter for noy-db.
 *
 * Turso is hosted libSQL — a fork of SQLite with built-in multi-region
 * replication, edge-friendly HTTP/WebSocket transport, and a native
 * `@libsql/client` driver whose API returns Promises (unlike
 * `better-sqlite3`'s synchronous methods).
 *
 * This package implements the 6-method `NoydbStore` contract directly
 * against a duck-typed `LibsqlClient`, not via a shim on top of
 * `@noy-db/to-sqlite`. Rationale: the sync vs async divide in the SQL
 * surface means a shim would either re-introduce a fake synchronous
 * layer (returning a Promise stored as a resolved value is awkward) or
 * duplicate the statement dispatch. A native async implementation is
 * cleaner.
 *
 * The internals match `@noy-db/to-sqlite` closely — same table, same
 * indexes, same DDL, same upsert pattern. Consumers moving from a
 * local SQLite file to hosted Turso can swap the factory call without
 * touching any other part of the config.
 *
 * @packageDocumentation
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, TxOp, ListPageResult } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'

/**
 * Duck-typed subset of `@libsql/client` — matches the common async
 * shape so `createClient({ url, authToken })` slots in directly.
 */
export interface LibsqlClient {
  execute(args: string | { sql: string; args?: readonly unknown[] }): Promise<LibsqlResultSet>
  batch?(statements: readonly { sql: string; args?: readonly unknown[] }[]): Promise<LibsqlResultSet[]>
}

export interface LibsqlResultSet {
  readonly rows: readonly Record<string, unknown>[]
}

export interface TursoStoreOptions {
  readonly client: LibsqlClient
  readonly tableName?: string
  readonly autoMigrate?: boolean
}

export function turso(options: TursoStoreOptions): NoydbStore {
  const { client, tableName = 'noydb_envelopes', autoMigrate = true } = options
  let schemaReady: Promise<void> | null = null

  async function ensureSchema(): Promise<void> {
    if (!autoMigrate) return
    if (!schemaReady) {
      schemaReady = (async () => {
        await client.execute(
          `CREATE TABLE IF NOT EXISTS ${tableName} (
             vault TEXT NOT NULL,
             collection TEXT NOT NULL,
             id TEXT NOT NULL,
             v INTEGER NOT NULL,
             ts TEXT NOT NULL,
             iv TEXT NOT NULL,
             data TEXT NOT NULL,
             by TEXT,
             tier INTEGER,
             elevated_by TEXT,
             det TEXT,
             PRIMARY KEY (vault, collection, id)
           )`,
        )
        await client.execute(
          `CREATE INDEX IF NOT EXISTS idx_${tableName}_vc
             ON ${tableName} (vault, collection)`,
        )
      })()
    }
    await schemaReady
  }

  function rowToEnvelope(row: Record<string, unknown>): EncryptedEnvelope {
    const by = row.by as string | null
    const tier = row.tier as number | null
    const elevatedBy = row.elevated_by as string | null
    const detRaw = row.det as string | null
    return {
      _noydb: 1,
      _v: row.v as number,
      _ts: row.ts as string,
      _iv: row.iv as string,
      _data: row.data as string,
      ...(by !== null && { _by: by }),
      ...(tier !== null && { _tier: tier }),
      ...(elevatedBy !== null && { _elevatedBy: elevatedBy }),
      ...(detRaw !== null && { _det: JSON.parse(detRaw) as Record<string, string> }),
    }
  }

  async function upsert(
    vault: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    expectedVersion?: number,
  ): Promise<void> {
    await ensureSchema()
    if (expectedVersion !== undefined) {
      const result = await client.execute({
        sql: `SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
        args: [vault, collection, id],
      })
      const existing = result.rows[0] as { v: number } | undefined
      if (existing && existing.v !== expectedVersion) {
        throw new ConflictError(existing.v, `Version conflict: expected ${expectedVersion}, found ${existing.v}`)
      }
    }
    await client.execute({
      sql:
        `INSERT INTO ${tableName} (vault, collection, id, v, ts, iv, data, by, tier, elevated_by, det)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(vault, collection, id) DO UPDATE SET
           v = excluded.v, ts = excluded.ts, iv = excluded.iv, data = excluded.data,
           by = excluded.by, tier = excluded.tier, elevated_by = excluded.elevated_by, det = excluded.det`,
      args: [
        vault, collection, id,
        envelope._v, envelope._ts, envelope._iv, envelope._data,
        envelope._by ?? null,
        envelope._tier ?? null,
        envelope._elevatedBy ?? null,
        envelope._det ? JSON.stringify(envelope._det) : null,
      ],
    })
  }

  const store: NoydbStore = {
    name: 'turso',

    async get(vault, collection, id) {
      await ensureSchema()
      const result = await client.execute({
        sql: `SELECT * FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
        args: [vault, collection, id],
      })
      const row = result.rows[0]
      return row ? rowToEnvelope(row) : null
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      await upsert(vault, collection, id, envelope, expectedVersion)
    },

    async delete(vault, collection, id) {
      await ensureSchema()
      await client.execute({
        sql: `DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
        args: [vault, collection, id],
      })
    },

    async list(vault, collection) {
      await ensureSchema()
      const result = await client.execute({
        sql: `SELECT id FROM ${tableName} WHERE vault = ? AND collection = ? ORDER BY id`,
        args: [vault, collection],
      })
      return result.rows.map(r => r.id as string)
    },

    async loadAll(vault) {
      await ensureSchema()
      const result = await client.execute({
        sql: `SELECT * FROM ${tableName} WHERE vault = ?`,
        args: [vault],
      })
      const snap: VaultSnapshot = {}
      for (const row of result.rows) {
        const collection = row.collection as string
        const id = row.id as string
        const bucket = snap[collection] ?? (snap[collection] = {})
        bucket[id] = rowToEnvelope(row)
      }
      return snap
    },

    async saveAll(vault, data) {
      await ensureSchema()
      if (client.batch) {
        const statements: { sql: string; args?: readonly unknown[] }[] = [
          { sql: `DELETE FROM ${tableName} WHERE vault = ?`, args: [vault] },
        ]
        for (const [collection, recs] of Object.entries(data)) {
          for (const [id, envelope] of Object.entries(recs)) {
            statements.push({
              sql:
                `INSERT INTO ${tableName} (vault, collection, id, v, ts, iv, data, by, tier, elevated_by, det)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(vault, collection, id) DO UPDATE SET
                   v = excluded.v, ts = excluded.ts, iv = excluded.iv, data = excluded.data,
                   by = excluded.by, tier = excluded.tier, elevated_by = excluded.elevated_by, det = excluded.det`,
              args: [
                vault, collection, id,
                envelope._v, envelope._ts, envelope._iv, envelope._data,
                envelope._by ?? null,
                envelope._tier ?? null,
                envelope._elevatedBy ?? null,
                envelope._det ? JSON.stringify(envelope._det) : null,
              ],
            })
          }
        }
        await client.batch(statements)
        return
      }
      // Fallback: sequential execute when the client lacks batch.
      await client.execute({ sql: `DELETE FROM ${tableName} WHERE vault = ?`, args: [vault] })
      for (const [collection, recs] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(recs)) {
          await upsert(vault, collection, id, envelope)
        }
      }
    },

    async ping() {
      try {
        await client.execute('SELECT 1')
        return true
      } catch {
        return false
      }
    },

    async listPage(vault, collection, cursor, limit = 100) {
      await ensureSchema()
      const afterId = cursor ?? ''
      const result = await client.execute({
        sql: `SELECT id, v, ts, iv, data, by, tier, elevated_by, det FROM ${tableName}
              WHERE vault = ? AND collection = ? AND id > ?
              ORDER BY id LIMIT ?`,
        args: [vault, collection, afterId, limit + 1],
      })
      const hasMore = result.rows.length > limit
      const trimmed = hasMore ? result.rows.slice(0, limit) : result.rows
      const items = trimmed.map(r => ({ id: r.id as string, envelope: rowToEnvelope(r) }))
      const res: ListPageResult = {
        items,
        nextCursor: hasMore ? (trimmed[trimmed.length - 1]!.id as string) : null,
      }
      return res
    },

    async tx(ops: readonly TxOp[]) {
      await ensureSchema()
      if (client.batch) {
        const statements: { sql: string; args?: readonly unknown[] }[] = []
        for (const op of ops) {
          if (op.type === 'put') {
            if (!op.envelope) throw new Error(`tx put op missing envelope for ${op.id}`)
            statements.push({
              sql:
                `INSERT INTO ${tableName} (vault, collection, id, v, ts, iv, data, by, tier, elevated_by, det)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(vault, collection, id) DO UPDATE SET
                   v = excluded.v, ts = excluded.ts, iv = excluded.iv, data = excluded.data,
                   by = excluded.by, tier = excluded.tier, elevated_by = excluded.elevated_by, det = excluded.det`,
              args: [
                op.vault, op.collection, op.id,
                op.envelope._v, op.envelope._ts, op.envelope._iv, op.envelope._data,
                op.envelope._by ?? null,
                op.envelope._tier ?? null,
                op.envelope._elevatedBy ?? null,
                op.envelope._det ? JSON.stringify(op.envelope._det) : null,
              ],
            })
          } else {
            statements.push({
              sql: `DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`,
              args: [op.vault, op.collection, op.id],
            })
          }
        }
        await client.batch(statements)
        return
      }
      // Fallback: no batch API — sequential execute (no atomic guarantee).
      for (const op of ops) {
        if (op.type === 'put') {
          if (!op.envelope) throw new Error(`tx put op missing envelope for ${op.id}`)
          await upsert(op.vault, op.collection, op.id, op.envelope, op.expectedVersion)
        } else {
          await store.delete(op.vault, op.collection, op.id)
        }
      }
    },
  }

  return store
}
