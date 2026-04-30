/**
 * **@noy-db/to-sqlite** — SQLite-backed noy-db store.
 *
 * Single-file local database for 10K+ record vaults where file-per-record
 * (`@noy-db/to-file`) starts to feel heavy. Encrypted envelopes land in
 * a single `noydb_envelopes` table keyed by `(vault, collection, id)`.
 *
 * ## Runtime — bring your own driver
 *
 * noy-db ships zero SQLite dependencies. Pass any driver whose `Database`
 * handle exposes `prepare(sql)` + `run()` / `get()` / `all()`:
 *
 *   - `better-sqlite3` (most common, synchronous API)
 *   - `node:sqlite` (Node 22+, same synchronous API shape)
 *   - `bun:sqlite`
 *   - A custom duck-typed wrapper around async drivers
 *
 * The store's `ensureSchema()` call creates the table + index on first
 * use; pass `autoMigrate: false` if the schema is provisioned out-of-band.
 *
 * ## Capabilities
 *
 * | Capability  | Value |
 * |-------------|-------|
 * | `casAtomic` | `true` — `UPDATE … WHERE _v = ?` inside a transaction |
 * | `txAtomic`  | `true` — `BEGIN IMMEDIATE … COMMIT` |
 * | `listPage`  | ✓ — ordered `LIMIT/OFFSET` paging |
 * | `ping`      | ✓ — `SELECT 1` round-trip |
 *
 * @packageDocumentation
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, TxOp, ListPageResult } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'

/**
 * Duck-typed `Database` interface — intentionally minimal so every
 * popular SQLite driver fits without an adapter shim.
 */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
}

export interface SqliteStatement {
  run(...params: readonly unknown[]): unknown
  get(...params: readonly unknown[]): unknown
  all(...params: readonly unknown[]): readonly unknown[]
}

export interface SqliteStoreOptions {
  /** Open database handle from better-sqlite3 / node:sqlite / bun:sqlite. */
  readonly db: SqliteDatabase
  /** Custom table name. Default `'noydb_envelopes'`. */
  readonly tableName?: string
  /** Run the CREATE TABLE IF NOT EXISTS DDL on store construction. Default `true`. */
  readonly autoMigrate?: boolean
}

interface Row {
  vault: string
  collection: string
  id: string
  v: number
  ts: string
  iv: string
  data: string
  by: string | null
  tier: number | null
  elevated_by: string | null
  det: string | null
}

export function sqlite(options: SqliteStoreOptions): NoydbStore {
  const { db, tableName = 'noydb_envelopes', autoMigrate = true } = options

  if (autoMigrate) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
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
      );
      CREATE INDEX IF NOT EXISTS idx_${tableName}_vault_collection
        ON ${tableName} (vault, collection);
      CREATE INDEX IF NOT EXISTS idx_${tableName}_vault_collection_ts
        ON ${tableName} (vault, collection, ts);
    `)
  }

  function rowToEnvelope(row: Row): EncryptedEnvelope {
    const env: EncryptedEnvelope = {
      _noydb: 1,
      _v: row.v,
      _ts: row.ts,
      _iv: row.iv,
      _data: row.data,
      ...(row.by !== null && { _by: row.by }),
      ...(row.tier !== null && { _tier: row.tier }),
      ...(row.elevated_by !== null && { _elevatedBy: row.elevated_by }),
      ...(row.det !== null && { _det: JSON.parse(row.det) as Record<string, string> }),
    }
    return env
  }

  function upsert(
    vault: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    expectedVersion?: number,
  ): void {
    if (expectedVersion !== undefined) {
      const existing = db
        .prepare(`SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
        .get(vault, collection, id) as { v: number } | undefined
      if (existing && existing.v !== expectedVersion) {
        throw new ConflictError(existing.v, `Version conflict: expected ${expectedVersion}, found ${existing.v}`)
      }
    }

    db.prepare(
      `INSERT INTO ${tableName} (vault, collection, id, v, ts, iv, data, by, tier, elevated_by, det)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vault, collection, id) DO UPDATE SET
         v = excluded.v, ts = excluded.ts, iv = excluded.iv, data = excluded.data,
         by = excluded.by, tier = excluded.tier, elevated_by = excluded.elevated_by, det = excluded.det`,
    ).run(
      vault,
      collection,
      id,
      envelope._v,
      envelope._ts,
      envelope._iv,
      envelope._data,
      envelope._by ?? null,
      envelope._tier ?? null,
      envelope._elevatedBy ?? null,
      envelope._det ? JSON.stringify(envelope._det) : null,
    )
  }

  const store: NoydbStore = {
    name: 'sqlite',

    async get(vault, collection, id) {
      const row = db
        .prepare(`SELECT * FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
        .get(vault, collection, id) as Row | undefined
      return row ? rowToEnvelope(row) : null
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      upsert(vault, collection, id, envelope, expectedVersion)
    },

    async delete(vault, collection, id) {
      db.prepare(`DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
        .run(vault, collection, id)
    },

    async list(vault, collection) {
      const rows = db
        .prepare(`SELECT id FROM ${tableName} WHERE vault = ? AND collection = ? ORDER BY id`)
        .all(vault, collection) as Array<{ id: string }>
      return rows.map(r => r.id)
    },

    async loadAll(vault) {
      const rows = db
        .prepare(`SELECT * FROM ${tableName} WHERE vault = ?`)
        .all(vault) as Row[]
      const snap: VaultSnapshot = {}
      for (const row of rows) {
        const bucket = snap[row.collection] ?? (snap[row.collection] = {})
        bucket[row.id] = rowToEnvelope(row)
      }
      return snap
    },

    async saveAll(vault, data) {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`DELETE FROM ${tableName} WHERE vault = ?`).run(vault)
        for (const [collection, recs] of Object.entries(data)) {
          for (const [id, envelope] of Object.entries(recs)) {
            upsert(vault, collection, id, envelope)
          }
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },

    async ping() {
      try {
        db.prepare('SELECT 1').get()
        return true
      } catch {
        return false
      }
    },

    async listPage(vault, collection, cursor, limit = 100) {
      const offset = cursor ? Number.parseInt(cursor, 10) : 0
      if (Number.isNaN(offset)) throw new Error(`Invalid cursor: ${cursor}`)

      const rows = db
        .prepare(
          `SELECT id, v, ts, iv, data, by, tier, elevated_by, det FROM ${tableName}
           WHERE vault = ? AND collection = ?
           ORDER BY id LIMIT ? OFFSET ?`,
        )
        .all(vault, collection, limit, offset) as Array<Row & { id: string }>

      const items = rows.map(r => ({
        id: r.id,
        envelope: rowToEnvelope({ ...r, vault, collection }),
      }))
      const result: ListPageResult = {
        items,
        nextCursor: rows.length < limit ? null : String(offset + limit),
      }
      return result
    },

    async tx(ops: readonly TxOp[]) {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const op of ops) {
          if (op.type === 'put') {
            if (!op.envelope) throw new Error(`tx put op missing envelope for ${op.id}`)
            upsert(op.vault, op.collection, op.id, op.envelope, op.expectedVersion)
          } else {
            if (op.expectedVersion !== undefined) {
              const existing = db
                .prepare(`SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
                .get(op.vault, op.collection, op.id) as { v: number } | undefined
              if (existing && existing.v !== op.expectedVersion) {
                throw new ConflictError(existing.v)
              }
            }
            db.prepare(`DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
              .run(op.vault, op.collection, op.id)
          }
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }

  return store
}
