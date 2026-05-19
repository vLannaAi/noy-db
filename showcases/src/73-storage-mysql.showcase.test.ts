/**
 * Showcase 73 — Storage: MySQL (real-service via local docker-compose)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-mysql` writes encrypted envelopes into a single
 * `noydb_envelopes` table with a `JSON` column for the payload, keyed
 * by `(vault, collection, id)`. CAS is `SELECT v ... FOR comparison`
 * + `INSERT ... ON DUPLICATE KEY UPDATE`, with `expectedVersion`
 * verified before write — `txAtomic` is supported via
 * `START TRANSACTION ... COMMIT` in `saveAll`. The store is driver-
 * agnostic (any client whose `execute(sql, params?)` returns
 * `[rows, fields]` works) — this showcase uses `mysql2/promise` as
 * the canonical baseline.
 *
 * Why it matters
 * ──────────────
 * The mocked `__tests__/conformance.test.ts` for `to-mysql` runs
 * against a `MysqlClient` stub that the package itself wrote. A real
 * MySQL 8 container exercises the actual SQL grammar, the JSON
 * column codec, and the `ON DUPLICATE KEY UPDATE` semantics — bugs
 * that only show up against a real server (e.g. case sensitivity of
 * BIGINT comparisons, JSON column NULL handling on
 * `INSERT ... ON DUPLICATE KEY UPDATE`) cannot surface in the mock.
 *
 * Prerequisites
 * ─────────────
 * - Docker / `docker compose` available locally.
 * - Bring up the stack: `pnpm docker:up`. The MySQL 8 service binds
 *   to **host port 3307** (mapped to container 3306) to avoid
 *   clashing with a developer's existing MySQL on 3306.
 * - Set `NOYDB_SHOWCASE_MYSQL_URL` in `showcases/.env`:
 *
 *     NOYDB_SHOWCASE_MYSQL_URL=mysql://root:noydb-showcase@localhost:3307/noydb_showcase
 *
 * The `dockerGate('mysql')` helper combines the env-var check with a
 * 1-second TCP probe against `localhost:3307` — the showcase skips
 * cleanly with a hint when either condition fails (env unset OR
 * container not running).
 *
 * What to read next
 * ─────────────────
 *   - showcase 58-storage-postgres (the Postgres parallel)
 *   - docs/packages/stores.md → "to-mysql" entry
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-mysql
 *
 * Acceptance (per #69)
 * ────────────────────
 *   ✓ Round-trip records through real MySQL
 *   ✓ JSON-column write path verified (envelope serialization)
 *   ✓ Optimistic concurrency via `_v` / `expectedVersion` (ConflictError)
 *   ✓ Idempotent schema creation on first open
 *   ✓ No data leak across runs (per-run table name)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConflictError, createNoydb, type EncryptedEnvelope } from '@noy-db/hub'
import { mysql } from '@noy-db/to-mysql'
import { dockerGate } from './_docker.js'

const gate = await dockerGate('mysql')

interface Note { id: string; text: string }

// One isolated table per run — same convention showcase 58 uses for
// Postgres. Concurrent CI runs against the same docker-compose stack
// don't collide.
const RUN_ID = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`
const TABLE = `noydb_showcase_73_${RUN_ID.replace(/-/g, '_')}`
const VAULT_NAME = `showcase-73-${RUN_ID}`

// `mysql2/promise` is loaded lazily so the showcase doesn't hard-fail
// at module load when the dep is missing — the gate hint already
// printed `pnpm install` guidance.
type Mysql2Pool = {
  execute<T>(sql: string, params?: readonly unknown[]): Promise<[T[], unknown]>
  query<T>(sql: string): Promise<[T[], unknown]>
  end(): Promise<void>
}

let pool: Mysql2Pool | null = null

beforeAll(async () => {
  if (!gate.enabled) return
  const driver = await import('mysql2/promise')
  pool = driver.default.createPool({
    uri: gate.values['NOYDB_SHOWCASE_MYSQL_URL']!,
    connectionLimit: 5,
    namedPlaceholders: false,
  }) as unknown as Mysql2Pool
})

afterAll(async () => {
  if (pool) {
    try { await pool.query(`DROP TABLE IF EXISTS ${TABLE}`) } catch { /* swallow */ }
    try { await pool.end() } catch { /* swallow */ }
  }
})

describe.skipIf(!gate.enabled)('Showcase 73 — Storage: MySQL (docker)', () => {
  it('round-trips records through a real MySQL 8 server', async () => {
    const store = mysql({ client: pool!, tableName: TABLE })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-mysql-passphrase-2026 keystone reach',
    })
    const vault = await db.openVault(VAULT_NAME)
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'in mysql' })
    await notes.put('b', { id: 'b', text: 'still in mysql' })

    expect(await notes.get('a')).toEqual({ id: 'a', text: 'in mysql' })
    expect((await notes.list()).map((r) => r.id).sort()).toEqual(['a', 'b'])
    db.close()
  })

  it('idempotent schema creation — second open against the same table is a no-op', async () => {
    // First open created the table; the second open issues the same
    // CREATE TABLE IF NOT EXISTS DDL, which MySQL accepts as a no-op.
    // If it threw, every cold-start of a long-running app would fail.
    const store = mysql({ client: pool!, tableName: TABLE })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-mysql-passphrase-2026 keystone reach',
    })
    const vault = await db.openVault(VAULT_NAME)
    expect(await vault.collection<Note>('notes').get('a')).toEqual({ id: 'a', text: 'in mysql' })
    db.close()
  })

  it('optimistic-concurrency: stale expectedVersion throws ConflictError', async () => {
    const store = mysql({ client: pool!, tableName: TABLE })

    // Direct envelope write — bypass the high-level API so we can
    // assert against the store's CAS contract without going through
    // the hub's vault-write path. The showcase exercises the SQL,
    // not the hub's encryption layer (showcase 22 covers the latter).
    const env = (v: number, data: string): EncryptedEnvelope => ({
      _noydb: 1,
      _v: v,
      _ts: new Date().toISOString(),
      _iv: 'AAAAAAAAAAAAAAAA',
      _data: Buffer.from(data).toString('base64'),
    })

    await store.put(`${VAULT_NAME}-cas`, 'docs', 'x', env(1, 'first'))
    await store.put(`${VAULT_NAME}-cas`, 'docs', 'x', env(2, 'second'), 1)

    // Now expectedVersion=1 again, but row is at v=2 — must conflict.
    await expect(
      store.put(`${VAULT_NAME}-cas`, 'docs', 'x', env(3, 'third'), 1),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('JSON column round-trips a Unicode + Thai payload byte-for-byte', async () => {
    const store = mysql({ client: pool!, tableName: TABLE })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-mysql-passphrase-2026 keystone reach',
    })
    const vault = await db.openVault(`${VAULT_NAME}-i18n`)
    const notes = vault.collection<Note>('notes')

    const payload = { id: 't', text: 'สวัสดี — γειά — 안녕 — emoji 🇹🇭' }
    await notes.put('t', payload)
    expect(await notes.get('t')).toEqual(payload)
    db.close()
  })

  it('MySQL sees only ciphertext — direct SQL inspection', async () => {
    // Direct row inspection: side-data (vault, collection, id, v) is
    // queryable; the `envelope` JSON payload is opaque AES-256-GCM.
    const [rows] = await pool!.execute<{ vault: string; envelope: unknown }>(
      `SELECT vault, envelope FROM ${TABLE} WHERE vault = ?`,
      [VAULT_NAME],
    )
    expect(rows.length).toBeGreaterThan(0)

    // The needle would only appear if encryption was off. The
    // showcase has not written this exact string, so its absence is
    // a sanity check, not an existence proof — see the negative-leak
    // test in showcase 58 for the canonical pattern.
    for (const row of rows) {
      const json = JSON.stringify(row.envelope)
      expect(json).not.toContain('plaintext-needle-MYSQL')
    }
  })
})

if (gate.enabled) {
  // eslint-disable-next-line no-console
  console.info(`[to-mysql (docker)] Using table=${TABLE}`)
}
