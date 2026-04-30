// @vitest-environment node
//
// `@libsql/client` uses fetch internally for hosted (libsql://) URLs,
// and happy-dom strips Authorization headers on cross-origin POSTs —
// same hazard as showcases 61, 62, 65, 66. Local SQLite-backed clients
// would work either way; the directive is for the hosted path.
/**
 * Showcase 67 — Storage: Turso (hosted libSQL, real-service, credentialed)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-turso` is a thin wrapper over a duck-typed `LibsqlClient`
 * (the shape `@libsql/client` exposes from its `createClient()` factory).
 * Records land in a single `noydb_envelopes` table; CAS is a SQLite
 * `UPDATE … WHERE v = ? RETURNING` round-trip — the same atomic
 * primitive `to-sqlite` and `to-postgres` use, just over libSQL's
 * embedded-SQLite-with-replication wire protocol.
 *
 * Why it matters
 * ──────────────
 * Turso is the canonical "serverless SQLite at the edge" backend —
 * libSQL forks SQLite to add replication, primary/replica topology,
 * and a hosted control plane. NOYDB encrypts before any byte hits
 * Turso, so the project's owner — even with full DB access — sees
 * only AES-256-GCM ciphertext in the envelope column. The same code
 * that runs against `to-sqlite` (showcase 54) runs unchanged against
 * Turso; the duck-typed `LibsqlClient` is the seam.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 54 (`to-sqlite` — the embedded local sibling).
 * - Showcase 58 (`to-postgres` — the same SQL CAS pattern).
 * - Real Turso database:
 *     - `NOYDB_SHOWCASE_TURSO_URL` (libsql://...)
 *     - `NOYDB_SHOWCASE_TURSO_AUTH_TOKEN` (CLI-issued JWT)
 *
 * Skipped cleanly when those aren't present.
 *
 * What to read next
 * ─────────────────
 *   - showcase 54-storage-sqlite (local SQLite, same SQL shape)
 *   - showcase 58-storage-postgres (the SQL sibling)
 *   - https://docs.turso.tech/sdk/ts/quickstart
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-turso
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createClient, type Client } from '@libsql/client'
import { createNoydb } from '@noy-db/hub'
import { turso } from '@noy-db/to-turso'
import { envGate, logSkipHint, TURSO_GATE_VARS } from './_env.js'

const gate = envGate({ label: 'to-turso', vars: TURSO_GATE_VARS })
logSkipHint('to-turso (showcase 67)', gate, TURSO_GATE_VARS)

interface Note { id: string; text: string }

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const TABLE = `noydb_showcase_67_${RUN_ID.replace(/-/g, '_')}`
const VAULT_NAME = `showcase-67-${RUN_ID}`

describe.skipIf(!gate.enabled)('Showcase 67 — Storage: Turso (hosted libSQL, real-service, credentialed)', () => {
  let client: Client | null = null

  afterAll(async () => {
    if (client) {
      try {
        await client.execute(`DROP TABLE IF EXISTS ${TABLE}`)
      } catch {
        /* best-effort */
      }
      client.close()
      client = null
    }
  })

  it('round-trips records through real Turso', async () => {
    client = createClient({
      url: gate.values['NOYDB_SHOWCASE_TURSO_URL']!,
      authToken: gate.values['NOYDB_SHOWCASE_TURSO_AUTH_TOKEN']!,
    })

    // The libsql Client's `batch` typing is slightly stricter than the
    // duck-typed LibsqlClient the store expects (mutable vs readonly
    // input array — variance bites here). Runtime behavior is identical;
    // cast through unknown to satisfy the structural check.
    const store = turso({ client: client as unknown as Parameters<typeof turso>[0]['client'], tableName: TABLE })
    expect(store.name).toBe('turso')

    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-turso-passphrase-2026',
    })
    const vault = await db.openVault(VAULT_NAME)
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'in turso' })
    await notes.put('b', { id: 'b', text: 'still in turso' })

    expect(await notes.get('a')).toEqual({ id: 'a', text: 'in turso' })
    expect((await notes.list()).map((r) => r.id).sort()).toEqual(['a', 'b'])
    db.close()
  })

  it('Turso sees only ciphertext — direct SQL inspection finds no plaintext', async () => {
    if (!client) {
      client = createClient({
        url: gate.values['NOYDB_SHOWCASE_TURSO_URL']!,
        authToken: gate.values['NOYDB_SHOWCASE_TURSO_AUTH_TOKEN']!,
      })
    }
    // The libsql Client's `batch` typing is slightly stricter than the
    // duck-typed LibsqlClient the store expects (mutable vs readonly
    // input array — variance bites here). Runtime behavior is identical;
    // cast through unknown to satisfy the structural check.
    const store = turso({ client: client as unknown as Parameters<typeof turso>[0]['client'], tableName: TABLE })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-turso-zk-passphrase-2026',
    })
    const vault = await db.openVault(`${VAULT_NAME}-zk`)
    await vault
      .collection<Note>('secrets')
      .put('top', { id: 'top', text: 'plaintext-needle-TURSO-KLM' })
    db.close()

    const result = await client.execute({
      sql: `SELECT * FROM ${TABLE} WHERE vault = ?`,
      args: [`${VAULT_NAME}-zk`],
    })
    expect(result.rows.length).toBeGreaterThan(0)
    for (const row of result.rows) {
      const json = JSON.stringify(row)
      expect(json).not.toContain('plaintext-needle-TURSO-KLM')
    }
  })
})

if (gate.enabled) {
  // eslint-disable-next-line no-console
  console.info(`[to-turso] Using table=${TABLE}`)
}
