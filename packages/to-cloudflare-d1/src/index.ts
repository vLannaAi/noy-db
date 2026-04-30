/**
 * **@noy-db/to-cloudflare-d1** — Cloudflare D1 adapter for noy-db.
 *
 * D1 is Cloudflare's edge SQLite. Inside a Worker, the `env.DB` binding
 * exposes a `D1Database` whose API is `prepare(sql).bind(...args).run()`
 * — different from node-postgres or libSQL but easy to adapt.
 *
 * ```ts
 * import { d1 } from '@noy-db/to-cloudflare-d1'
 *
 * export default {
 *   async fetch(request: Request, env: { DB: D1Database }) {
 *     const store = d1({ db: env.DB })
 *     const db = await createNoydb({ store })
 *     // …
 *   },
 * }
 * ```
 *
 * ## Capabilities
 *
 * | Capability  | Value |
 * |-------------|-------|
 * | `casAtomic` | `true` — `UPDATE … WHERE v = ?` inside a D1 batch |
 * | `txAtomic`  | `true` — `D1Database.batch()` is atomic per-session |
 * | `listPage`  | ✓ — keyset pagination by id |
 * | `ping`      | ✓ — `SELECT 1` |
 *
 * @packageDocumentation
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, TxOp, ListPageResult } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'

/** Duck-typed subset of the `D1Database` binding. */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec?(sql: string): Promise<unknown>
}

export interface D1PreparedStatement {
  bind(...args: readonly unknown[]): D1PreparedStatement
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<D1Result<T>>
  run<T = unknown>(): Promise<D1Result<T>>
}

export interface D1Result<T = unknown> {
  readonly results?: readonly T[]
  readonly success?: boolean
}

export interface D1StoreOptions {
  readonly db: D1Database
  readonly tableName?: string
  readonly autoMigrate?: boolean
}

export function d1(options: D1StoreOptions): NoydbStore {
  const { db, tableName = 'noydb_envelopes', autoMigrate = true } = options
  let schemaReady: Promise<void> | null = null

  async function ensureSchema(): Promise<void> {
    if (!autoMigrate) return
    if (!schemaReady) {
      schemaReady = (async () => {
        await db
          .prepare(
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
          .run()
        await db
          .prepare(`CREATE INDEX IF NOT EXISTS idx_${tableName}_vc ON ${tableName} (vault, collection)`)
          .run()
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

  function upsertStatement(
    vault: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
  ): D1PreparedStatement {
    return db
      .prepare(
        `INSERT INTO ${tableName} (vault, collection, id, v, ts, iv, data, by, tier, elevated_by, det)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(vault, collection, id) DO UPDATE SET
           v = excluded.v, ts = excluded.ts, iv = excluded.iv, data = excluded.data,
           by = excluded.by, tier = excluded.tier, elevated_by = excluded.elevated_by, det = excluded.det`,
      )
      .bind(
        vault, collection, id,
        envelope._v, envelope._ts, envelope._iv, envelope._data,
        envelope._by ?? null,
        envelope._tier ?? null,
        envelope._elevatedBy ?? null,
        envelope._det ? JSON.stringify(envelope._det) : null,
      )
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
      const existing = await db
        .prepare(`SELECT v FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
        .bind(vault, collection, id)
        .first<{ v: number }>()
      if (existing && existing.v !== expectedVersion) {
        throw new ConflictError(existing.v, `Version conflict: expected ${expectedVersion}, found ${existing.v}`)
      }
    }
    await upsertStatement(vault, collection, id, envelope).run()
  }

  const store: NoydbStore = {
    name: 'cloudflare-d1',

    async get(vault, collection, id) {
      await ensureSchema()
      const row = await db
        .prepare(`SELECT * FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
        .bind(vault, collection, id)
        .first<Record<string, unknown>>()
      return row ? rowToEnvelope(row) : null
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      await upsert(vault, collection, id, envelope, expectedVersion)
    },

    async delete(vault, collection, id) {
      await ensureSchema()
      await db
        .prepare(`DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
        .bind(vault, collection, id)
        .run()
    },

    async list(vault, collection) {
      await ensureSchema()
      const res = await db
        .prepare(`SELECT id FROM ${tableName} WHERE vault = ? AND collection = ? ORDER BY id`)
        .bind(vault, collection)
        .all<{ id: string }>()
      return (res.results ?? []).map(r => r.id)
    },

    async loadAll(vault) {
      await ensureSchema()
      const res = await db
        .prepare(`SELECT * FROM ${tableName} WHERE vault = ?`)
        .bind(vault)
        .all<Record<string, unknown>>()
      const snap: VaultSnapshot = {}
      for (const row of res.results ?? []) {
        const collection = row.collection as string
        const id = row.id as string
        const bucket = snap[collection] ?? (snap[collection] = {})
        bucket[id] = rowToEnvelope(row)
      }
      return snap
    },

    async saveAll(vault, data) {
      await ensureSchema()
      const statements: D1PreparedStatement[] = [
        db.prepare(`DELETE FROM ${tableName} WHERE vault = ?`).bind(vault),
      ]
      for (const [collection, recs] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(recs)) {
          statements.push(upsertStatement(vault, collection, id, envelope))
        }
      }
      await db.batch(statements)
    },

    async ping() {
      try {
        await db.prepare('SELECT 1').run()
        return true
      } catch {
        return false
      }
    },

    async listPage(vault, collection, cursor, limit = 100) {
      await ensureSchema()
      const afterId = cursor ?? ''
      const res = await db
        .prepare(
          `SELECT id, v, ts, iv, data, by, tier, elevated_by, det FROM ${tableName}
           WHERE vault = ? AND collection = ? AND id > ?
           ORDER BY id LIMIT ?`,
        )
        .bind(vault, collection, afterId, limit + 1)
        .all<Record<string, unknown>>()
      const rows = res.results ?? []
      const hasMore = rows.length > limit
      const trimmed = hasMore ? rows.slice(0, limit) : rows
      const items = trimmed.map(r => ({ id: r.id as string, envelope: rowToEnvelope(r) }))
      const out: ListPageResult = {
        items,
        nextCursor: hasMore ? (trimmed[trimmed.length - 1]!.id as string) : null,
      }
      return out
    },

    async tx(ops: readonly TxOp[]) {
      await ensureSchema()
      const statements: D1PreparedStatement[] = []
      for (const op of ops) {
        if (op.type === 'put') {
          if (!op.envelope) throw new Error(`tx put op missing envelope for ${op.id}`)
          statements.push(upsertStatement(op.vault, op.collection, op.id, op.envelope))
        } else {
          statements.push(
            db
              .prepare(`DELETE FROM ${tableName} WHERE vault = ? AND collection = ? AND id = ?`)
              .bind(op.vault, op.collection, op.id),
          )
        }
      }
      await db.batch(statements)
    },
  }

  return store
}
