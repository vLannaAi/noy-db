/**
 * Showcase 50 — as-json import (preview + apply with three policies)
 *
 * What you'll learn
 * ─────────────────
 * The import-side counterpart of `as-json.toString()`. `fromString()`
 * parses a JSON document into records, runs `diffVault()` against the
 * live vault, and returns an `ImportPlan` whose `apply()` writes the
 * changes through the normal collection API. The plan is buffered so
 * UI consumers can render review-then-confirm without a separate
 * dry-run mode.
 *
 * Three reconciliation policies pick what `apply()` does with each
 * bucket:
 *   - `'merge'` (default) — insert + update, never delete
 *   - `'replace'` — full mirror; absent records get deleted
 *   - `'insert-only'` — append-only; modifications skipped
 *
 * Why it matters
 * ──────────────
 * "Round-trip the December invoices through my accountant's
 * spreadsheet" is the canonical workflow that today requires custom
 * glue. `fromString()` is the noy-db answer — preview the diff, pick
 * the policy, apply.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 34-as-json (export side)
 * - Hub primitive: `diffVault()` is the engine underneath
 *
 * What to read next
 * ─────────────────
 *   - showcase 51 (when added): as-csv / as-ndjson / as-zip readers
 *   - docs/packages/as-exports.md (the import section)
 *
 * Spec mapping
 * ────────────
 * features.yaml → exports → as-json (#302 phase 1)
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { fromString, toString } from '@noy-db/as-json'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; client: string; amount: number; status: 'draft' | 'paid' }

async function setup() {
  const store = memory()
  const db = await createNoydb({ store, user: 'alice', secret: 'as-json-import-pw-2026' })
  const vault = await db.openVault('demo')

  const inv = vault.collection<Invoice>('invoices')
  await inv.put('a', { id: 'a', client: 'Globex', amount: 100, status: 'draft' })
  await inv.put('b', { id: 'b', client: 'Acme', amount: 200, status: 'paid' })
  await inv.put('c', { id: 'c', client: 'Stark', amount: 300, status: 'paid' })
  return { db, vault, store }
}

describe('Showcase 50 — as-json import', () => {
  it('preview: fromString returns a VaultDiff plan with summary counts', async () => {
    const { db, vault } = await setup()
    const candidate = JSON.stringify({
      invoices: [
        { id: 'a', client: 'Globex', amount: 100, status: 'draft' },         // unchanged
        { id: 'b', client: 'Acme', amount: 200, status: 'overdue' },         // modified (status)
        // 'c' missing — deleted under 'replace'
        { id: 'd', client: 'Wayne', amount: 400, status: 'draft' },          // added
      ],
    })

    const importer = await fromString(vault, candidate)
    expect(importer.plan.summary).toEqual({ add: 1, modify: 1, delete: 1, total: 3 })
    expect(importer.plan.added.map((e) => e.id)).toEqual(['d'])
    expect(importer.plan.modified[0]!.fieldsChanged).toEqual(['status'])
    db.close()
  })

  it('apply with merge policy (default) — inserts + updates, never deletes', async () => {
    const { db, vault } = await setup()
    const candidate = JSON.stringify({
      invoices: [
        { id: 'b', client: 'Acme', amount: 200, status: 'overdue' },
        { id: 'd', client: 'Wayne', amount: 400, status: 'draft' },
      ],
    })

    const importer = await fromString(vault, candidate)
    await importer.apply()

    const inv = vault.collection<Invoice>('invoices')
    expect(await inv.get('a')).toMatchObject({ status: 'draft' })  // untouched
    expect(await inv.get('b')).toMatchObject({ status: 'overdue' })  // modified
    expect(await inv.get('c')).toMatchObject({ status: 'paid' })  // not deleted
    expect(await inv.get('d')).toMatchObject({ amount: 400 })  // added
    db.close()
  })

  it('apply with replace policy — full mirror, deletes absent records', async () => {
    const { db, vault } = await setup()
    const candidate = JSON.stringify({
      invoices: [
        { id: 'a', client: 'Globex', amount: 100, status: 'draft' },
        { id: 'b', client: 'Acme', amount: 200, status: 'paid' },
        // 'c' missing
      ],
    })

    const importer = await fromString(vault, candidate, { policy: 'replace' })
    await importer.apply()

    const inv = vault.collection<Invoice>('invoices')
    expect(await inv.get('a')).not.toBeNull()
    expect(await inv.get('b')).not.toBeNull()
    expect(await inv.get('c')).toBeNull()  // deleted
    db.close()
  })

  it('apply with insert-only policy — modifications + deletes ignored', async () => {
    const { db, vault } = await setup()
    const candidate = JSON.stringify({
      invoices: [
        { id: 'b', client: 'WOULD_OVERWRITE', amount: 999, status: 'draft' },  // skipped
        { id: 'd', client: 'Wayne', amount: 400, status: 'draft' },             // added
      ],
    })

    const importer = await fromString(vault, candidate, { policy: 'insert-only' })
    await importer.apply()

    const inv = vault.collection<Invoice>('invoices')
    expect(await inv.get('b')).toMatchObject({ client: 'Acme', amount: 200 })  // unchanged
    expect(await inv.get('d')).toMatchObject({ client: 'Wayne' })  // added
    db.close()
  })

  it('round-trip: toString → fromString reconstructs an empty target vault', async () => {
    const { db: src, vault: srcVault, store: srcStore } = await setup()
    // Grant + close + re-open so toString sees the updated capability.
    await src.grant('demo', {
      userId: 'alice', displayName: 'Alice', role: 'owner',
      passphrase: 'as-json-import-pw-2026',
      exportCapability: { plaintext: ['json'] },
    })
    src.close()

    const exporterDb = await createNoydb({ store: srcStore, user: 'alice', secret: 'as-json-import-pw-2026' })
    const exporterVault = await exporterDb.openVault('demo')
    const json = await toString(exporterVault, { pretty: 2 })
    exporterDb.close()
    void srcVault

    // Fresh vault on a new adapter — every record arrives as 'added'.
    const dstStore = memory()
    const dstDb = await createNoydb({ store: dstStore, user: 'alice', secret: 'as-json-import-pw-2026' })
    const dstVault = await dstDb.openVault('demo')

    const importer = await fromString(dstVault, json)
    expect(importer.plan.summary).toEqual({ add: 3, modify: 0, delete: 0, total: 3 })

    await importer.apply()
    const got = await dstVault.collection<Invoice>('invoices').get('a')
    expect(got).toMatchObject({ id: 'a', client: 'Globex', amount: 100 })
    dstDb.close()
  })
})
