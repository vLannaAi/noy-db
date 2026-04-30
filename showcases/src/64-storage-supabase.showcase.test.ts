/**
 * Showcase 64 — Storage: Supabase Postgres (real-service, credentialed)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-supabase` is a thin factory over `@noy-db/to-postgres`
 * — same `query(sql, params)` contract, same casAtomic + txAtomic
 * capabilities, but the package's `name` is `'supabase'` so meter
 * snapshots distinguish it from a self-hosted Postgres. The package
 * deliberately does NOT embed `@supabase/supabase-js`; you bring
 * your own Postgres-compatible client (`pg`, `postgres.js`, the
 * Supabase serverless driver, etc.) and pass it in. This showcase
 * uses `pg` because it's the smallest dependency that works.
 *
 * Why it matters
 * ──────────────
 * Supabase is the canonical "managed Postgres + a Storage bucket
 * service" that an adopter on a small team picks when they want SQL
 * + blob storage in one billing line. NOYDB encrypts before any
 * byte hits Supabase, so the project's owner — even with full DB
 * superuser access — sees only AES-256-GCM ciphertext in the
 * envelope column. The same passphrase derives the same KEK on every
 * client; Supabase becomes a sync bus, not a source of truth.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 58 (`to-postgres` — the parent implementation).
 * - Real Supabase project:
 *     - `NOYDB_SHOWCASE_SUPABASE_DB_URL` — direct Postgres URL with
 *       password. Settings → Database → Connection string → "URI".
 *
 * Skipped cleanly when the env var isn't set. The skip-hint tells
 * the developer exactly which key to fill in.
 *
 * What to read next
 * ─────────────────
 *   - showcase 65-topology-supabase-blob (records + blob via Storage)
 *   - showcase 58-storage-postgres (the SQL sibling)
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-supabase
 */

import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createNoydb } from '@noy-db/hub'
import { supabase } from '@noy-db/to-supabase'
import { envGate, logSkipHint, SUPABASE_DB_GATE_VARS } from './_env.js'

const gate = envGate({ label: 'to-supabase', vars: SUPABASE_DB_GATE_VARS })
logSkipHint('to-supabase (showcase 64)', gate, SUPABASE_DB_GATE_VARS)

interface Note { id: string; text: string }

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const TABLE = `noydb_showcase_64_${RUN_ID.replace(/-/g, '_')}`
const VAULT_NAME = `showcase-64-${RUN_ID}`

describe.skipIf(!gate.enabled)('Showcase 64 — Storage: Supabase Postgres (real-service, credentialed)', () => {
  const url = gate.values['NOYDB_SHOWCASE_SUPABASE_DB_URL']!
  const client = new pg.Client({ connectionString: url })
  let connected = false

  afterAll(async () => {
    if (connected) {
      await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {})
      await client.end().catch(() => {})
    }
  })

  it('round-trips records through a real Supabase Postgres database', async () => {
    await client.connect()
    connected = true

    const store = supabase({ client, tableName: TABLE })
    expect(store.name).toBe('supabase')

    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-supabase-passphrase-2026',
    })
    const vault = await db.openVault(VAULT_NAME)
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'in supabase' })
    await notes.put('b', { id: 'b', text: 'still in supabase' })

    expect(await notes.get('a')).toEqual({ id: 'a', text: 'in supabase' })
    expect((await notes.list()).map((r) => r.id).sort()).toEqual(['a', 'b'])
    db.close()
  })

  it('Supabase Postgres sees only ciphertext — direct SQL inspection finds no plaintext', async () => {
    const store = supabase({ client, tableName: TABLE })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-supabase-zk-passphrase-2026',
    })
    const vault = await db.openVault(`${VAULT_NAME}-zk`)
    await vault
      .collection<Note>('secrets')
      .put('top', { id: 'top', text: 'plaintext-needle-SUPABASE-MNO' })
    db.close()

    const { rows } = await client.query<{ vault: string; envelope: unknown }>(
      `SELECT vault, envelope FROM ${TABLE} WHERE vault = $1`,
      [`${VAULT_NAME}-zk`],
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(JSON.stringify(row.envelope)).not.toContain('plaintext-needle-SUPABASE-MNO')
    }
  })
})

if (gate.enabled) {
  // eslint-disable-next-line no-console
  console.info(`[to-supabase] Using table=${TABLE}`)
}
