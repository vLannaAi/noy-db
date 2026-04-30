// @vitest-environment node
//
// The showcases package defaults to `happy-dom` (vitest.config.ts) for Vue /
// Pinia / React reactivity tests. happy-dom enforces same-origin policy on
// global `fetch`, which blocks our cross-origin POST to api.cloudflare.com
// with "Cross-Origin Request Blocked" before the request leaves the process.
// This file uses Node's native `fetch` instead — no DOM, no CORS guard, the
// HTTP request actually goes out. AWS-SDK-based showcases (57, 60) don't
// hit this because the SDK uses `node:https` directly, not the fetch global.
/**
 * Showcase 61 — Storage: Cloudflare D1 (real-service, REST shim, credentialed)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-cloudflare-d1` is duck-typed against the D1 binding
 * surface — `prepare(sql).bind(...).run()`, `.first()`, `.all()`,
 * plus `db.batch(statements)`. Inside a Cloudflare Worker you pass
 * `env.DB` directly. From Node (or any non-Worker host) you build a
 * tiny REST shim that implements the same shape against D1's HTTP
 * API. This showcase ships that shim inline so the canonical "drive
 * D1 from your CI / dev box" pattern is concrete and copyable.
 *
 * Why it matters
 * ──────────────
 * D1 is Cloudflare's edge SQLite — replicated, eventually consistent,
 * 5 GB free tier. The store gets `casAtomic: true` from D1's UPDATE
 * affected-row count semantics, the same shape `to-postgres` uses.
 * For an adopter running their app on Workers, swapping `to-postgres`
 * for `to-cloudflare-d1` is a one-line change because the duck-typed
 * statement shapes line up. From outside Workers — what a CI pipeline
 * or migration job needs — the REST API is the only path; this
 * showcase is the reference implementation.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 58 (`to-postgres` — the SQL sibling that shares the CAS
 *   strategy).
 * - Real Cloudflare D1:
 *     - `NOYDB_SHOWCASE_D1_ACCOUNT_ID` (Cloudflare dashboard sidebar)
 *     - `NOYDB_SHOWCASE_D1_DATABASE_ID` (the database's overview page)
 *     - `NOYDB_SHOWCASE_D1_API_TOKEN` (My Profile → API Tokens →
 *       custom token with `Account: D1: Edit` permission)
 *
 * Skipped cleanly when those aren't present.
 *
 * What to read next
 * ─────────────────
 *   - showcase 58-storage-postgres (SQL sibling)
 *   - https://developers.cloudflare.com/d1/build-with-d1/d1-client-api/
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-cloudflare-d1
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { d1 } from '@noy-db/to-cloudflare-d1'
import { envGate, logSkipHint, D1_GATE_VARS } from './_env.js'
import { sdkD1 } from './_d1-sdk.js'

const gate = envGate({ label: 'to-cloudflare-d1', vars: D1_GATE_VARS })
logSkipHint('to-cloudflare-d1 (showcase 61)', gate, D1_GATE_VARS)

interface Note { id: string; text: string }

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const TABLE = `noydb_showcase_61_${RUN_ID.replace(/-/g, '_')}`
const VAULT_NAME = `showcase-61-${RUN_ID}`

describe.skipIf(!gate.enabled)('Showcase 61 — Storage: Cloudflare D1 (real-service, REST shim, credentialed)', () => {
  const accountId = gate.values['NOYDB_SHOWCASE_D1_ACCOUNT_ID']!
  const databaseId = gate.values['NOYDB_SHOWCASE_D1_DATABASE_ID']!
  const apiToken = gate.values['NOYDB_SHOWCASE_D1_API_TOKEN']!

  const db = sdkD1({ accountId, databaseId, apiToken })

  afterAll(async () => {
    try {
      await db.prepare(`DROP TABLE IF EXISTS ${TABLE}`).run()
    } catch (err) {
      const code = (err as { name?: string }).name ?? 'unknown'
      // eslint-disable-next-line no-console
      console.warn(
        `[to-cloudflare-d1] afterAll cleanup skipped (${code}). Drop the table manually if needed: DROP TABLE ${TABLE};`,
      )
    }
  })

  it('round-trips records through real Cloudflare D1', async () => {
    const store = d1({ db, tableName: TABLE })
    const noydb = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-d1-passphrase-2026',
    })
    const vault = await noydb.openVault(VAULT_NAME)
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'in d1' })
    await notes.put('b', { id: 'b', text: 'still in d1' })

    expect(await notes.get('a')).toEqual({ id: 'a', text: 'in d1' })
    expect((await notes.list()).map((r) => r.id).sort()).toEqual(['a', 'b'])
    noydb.close()
  })

  it('D1 sees only ciphertext — direct SQL inspection finds no plaintext', async () => {
    const store = d1({ db, tableName: TABLE })
    const noydb = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-d1-zk-passphrase-2026',
    })
    const vault = await noydb.openVault(`${VAULT_NAME}-zk`)
    await vault
      .collection<Note>('secrets')
      .put('top', { id: 'top', text: 'plaintext-needle-D1-XYZ' })
    noydb.close()

    // Direct SQL: pull every row for our zk vault and confirm the
    // needle never appears in the encrypted-side `data` column or any
    // of the cleartext metadata columns (vault / collection / id /
    // _v / _ts — none of which should contain user content).
    const stmt = db
      .prepare(`SELECT * FROM ${TABLE} WHERE vault = ?`)
      .bind(`${VAULT_NAME}-zk`)
    const r = await stmt.all<Record<string, unknown>>()
    expect(r.results?.length ?? 0).toBeGreaterThan(0)
    for (const row of r.results ?? []) {
      const json = JSON.stringify(row)
      expect(json).not.toContain('plaintext-needle-D1-XYZ')
    }
  })
})

if (gate.enabled) {
  // eslint-disable-next-line no-console
  console.info(
    `[to-cloudflare-d1] Using account=${gate.values['NOYDB_SHOWCASE_D1_ACCOUNT_ID']?.slice(0, 8)}… database=${gate.values['NOYDB_SHOWCASE_D1_DATABASE_ID']?.slice(0, 8)}… table=${TABLE}`,
  )
}
