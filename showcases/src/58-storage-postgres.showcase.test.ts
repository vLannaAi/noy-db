/**
 * Showcase 58 — Storage: Postgres (real-service, credentialed)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-postgres` writes encrypted envelopes into a single
 * `noydb_envelopes` table with a `jsonb` column for the payload, keyed
 * by `(vault, collection, id)`. CAS is `UPDATE … WHERE v = $expected
 * RETURNING id`, so it inherits Postgres's atomic row-level guarantees
 * without any extension dependencies. The store is driver-agnostic —
 * any `query(sql, params?) → { rows: [...] }` shape works (`pg`,
 * `postgres.js`, `@vercel/postgres`, `@neondatabase/serverless`,
 * `drizzle-orm`'s raw pool, …). This showcase uses `pg` because it's
 * the canonical baseline.
 *
 * Why it matters
 * ──────────────
 * Postgres is the right answer when the team already runs Postgres,
 * wants `BEGIN…COMMIT` atomicity, and needs SQL-level ad-hoc queries
 * over the encrypted side-data (e.g. `SELECT vault, count(*) ...`
 * works fine — only the payload column is opaque). NOYDB's record-
 * level encryption means even a Postgres superuser sees only
 * AES-256-GCM ciphertext.
 *
 * Prerequisites
 * ─────────────
 * - This showcase requires `NOYDB_SHOWCASE_POSTGRES_URL` in
 *   `showcases/.env`. Local dev is one command:
 *
 *     docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16
 *     # then in showcases/.env:
 *     # NOYDB_SHOWCASE_POSTGRES_URL=postgres://postgres:dev@localhost:5432/postgres
 *
 * Skipped cleanly when the env var isn't set.
 *
 * What to read next
 * ─────────────────
 *   - showcase 54-storage-sqlite (the embedded local equivalent)
 *   - docs/packages/stores.md → "to-postgres" entry for connection-pool guidance
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-postgres
 */

import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createNoydb } from '@noy-db/hub'
import { postgres } from '@noy-db/to-postgres'
import { envGate, logSkipHint, POSTGRES_GATE_VARS } from './_env.js'

const gate = envGate({ label: 'to-postgres', vars: POSTGRES_GATE_VARS })
logSkipHint('to-postgres (showcase 58)', gate, POSTGRES_GATE_VARS)

interface Note { id: string; text: string }

// One isolated table per run keeps concurrent test runs (CI matrix,
// developer + agent on the same DB) from colliding without forcing the
// developer to provision a fresh database per run.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const TABLE = `noydb_showcase_58_${RUN_ID.replace(/-/g, '_')}`
const VAULT_NAME = `showcase-58-${RUN_ID}`

describe.skipIf(!gate.enabled)('Showcase 58 — Storage: Postgres (real-service, credentialed)', () => {
  const url = gate.values['NOYDB_SHOWCASE_POSTGRES_URL']!
  const client = new pg.Client({ connectionString: url })
  let connected = false

  afterAll(async () => {
    if (connected) {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {})
      await client.end().catch(() => {})
    }
  })

  it('round-trips records through a real Postgres database', async () => {
    await client.connect()
    connected = true

    const store = postgres({ client, tableName: TABLE })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-postgres-passphrase-2026',
    })
    const vault = await db.openVault(VAULT_NAME)
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'in postgres' })
    await notes.put('b', { id: 'b', text: 'still in postgres' })

    expect(await notes.get('a')).toEqual({ id: 'a', text: 'in postgres' })
    expect((await notes.list()).map((r) => r.id).sort()).toEqual(['a', 'b'])
    db.close()
  })

  it('Postgres sees only ciphertext — table is queryable but payload is opaque', async () => {
    const store = postgres({ client, tableName: TABLE })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-postgres-zk-passphrase-2026',
    })
    const vault = await db.openVault(`${VAULT_NAME}-zk`)
    await vault.collection<Note>('secrets').put('top', { id: 'top', text: 'plaintext-needle-ABC' })
    db.close()

    // Direct SQL inspection — the side-data (vault, collection, id, _v,
    // _ts) is queryable as expected, but the envelope payload is
    // AES-256-GCM ciphertext.
    const { rows } = await client.query<{ vault: string; collection: string; id: string; envelope: unknown }>(
      `SELECT vault, collection, id, envelope FROM ${TABLE} WHERE vault = $1`,
      [`${VAULT_NAME}-zk`],
    )
    expect(rows.length).toBeGreaterThan(0)

    // The needle never appears in any envelope — only `_data`'s base64
    // ciphertext + the always-clear `_v` / `_ts` / `_iv` survive.
    for (const row of rows) {
      const json = JSON.stringify(row.envelope)
      expect(json).not.toContain('plaintext-needle-ABC')
    }
  })
})

if (gate.enabled) {
  // Don't print the connection URL — it carries credentials. The hint
  // above already showed which vars opened the gate.
  // eslint-disable-next-line no-console
  console.info(`[to-postgres] Using table=${TABLE}`)
}
