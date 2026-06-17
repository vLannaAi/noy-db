/**
 * migrateThenMerge — two-stage upgrade-then-merge pipeline (FR-8).
 * Plan: docs/superpowers/plans/2026-06-17-fr8-migrate-then-merge.md §Task 4.
 *
 * Fixture overview
 * ----------------
 *   Case (a) + (d): source has OLD shape { id, fullName }; receiver schema
 *     requires NEW shape { id, firstName, lastName }.
 *   Case (b): same scenario but fromVersion > toVersion (newer bundle refusal).
 *   Case (c): receiver schema adds an OPTIONAL field `{ id, name, note? }`;
 *     incoming shape `{ id, name }` still validates → additive fast-path.
 *   Case (e): source and receiver have the SAME shape (same-version direct merge).
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '@noy-db/hub'
import { extractPartition } from '@noy-db/hub/bundle'
import { memory } from '@noy-db/to-memory'
import {
  migrateThenMerge,
  MinVersionError,
  MigrationTransformRequiredError,
} from '../src/interchange/migrate-then-merge.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface OldClient { id: string; fullName: string }
interface NewClient { id: string; firstName: string; lastName: string }
interface SimpleClient { id: string; name: string }
interface SimpleClientWithNote { id: string; name: string; note?: string }

// ─── Helpers: case (a) + (b) + (d) — split-name scenario ────────────────────

/** Source vault with OLD shape { id, fullName }. */
async function buildOldBundle() {
  const sourceDb = await createNoydb({ store: memory(), user: 'src-old', secret: 'src-old-secret-123' })
  const source = await sourceDb.openVault('source-old')
  const clients = source.collection<OldClient>('clients')
  await clients.put('c1', { id: 'c1', fullName: 'Jane Doe' })
  await clients.put('c2', { id: 'c2', fullName: 'John Smith' })

  const { bundleBytes, transferKey } = await extractPartition(source, {
    seeds: { clients: () => true },
  })
  return { bundleBytes, transferKey }
}

/**
 * Receiver vault whose schema requires the NEW shape { id, firstName, lastName }.
 * The collection is declared with a zod schema so validateInput actually enforces it.
 */
async function buildNewSchemaReceiver() {
  const db = await createNoydb({ store: memory(), user: 'recv-new', secret: 'recv-new-secret-456' })
  const vault = await db.openVault('receiver-new')
  // Register the target schema — collection validation will enforce it
  vault.collection<NewClient>('clients', {
    schema: z.object({
      id: z.string(),
      firstName: z.string(),
      lastName: z.string(),
    }),
  })
  return vault
}

// ─── Helpers: case (c) — additive fast-path ──────────────────────────────────

/** Source vault with { id, name } — the base shape. */
async function buildSimpleBundle() {
  const sourceDb = await createNoydb({ store: memory(), user: 'src-simple', secret: 'src-simple-secret-123' })
  const source = await sourceDb.openVault('source-simple')
  const clients = source.collection<SimpleClient>('clients')
  await clients.put('c1', { id: 'c1', name: 'Alice' })
  await clients.put('c2', { id: 'c2', name: 'Bob' })

  const { bundleBytes, transferKey } = await extractPartition(source, {
    seeds: { clients: () => true },
  })
  return { bundleBytes, transferKey }
}

/**
 * Receiver whose schema adds an OPTIONAL field `note?` — additive evolution.
 * Incoming records `{ id, name }` still pass this schema (extra optional field is fine).
 */
async function buildAdditiveReceiver() {
  const db = await createNoydb({ store: memory(), user: 'recv-add', secret: 'recv-add-secret-456' })
  const vault = await db.openVault('receiver-add')
  vault.collection<SimpleClientWithNote>('clients', {
    schema: z.object({
      id: z.string(),
      name: z.string(),
      note: z.string().optional(),
    }),
  })
  return vault
}

// ─── Helpers: case (e) — same-version direct merge ───────────────────────────

async function buildSameVersionBundle() {
  const sourceDb = await createNoydb({ store: memory(), user: 'src-sv', secret: 'src-sv-secret-123' })
  const source = await sourceDb.openVault('source-sv')
  const clients = source.collection<SimpleClient>('clients')
  await clients.put('c1', { id: 'c1', name: 'Alice' })

  const { bundleBytes, transferKey } = await extractPartition(source, {
    seeds: { clients: () => true },
  })
  return { bundleBytes, transferKey }
}

async function buildSameVersionReceiver() {
  const db = await createNoydb({ store: memory(), user: 'recv-sv', secret: 'recv-sv-secret-456' })
  const vault = await db.openVault('receiver-sv')
  return vault
}

// ─── Split-name transform ─────────────────────────────────────────────────────

function splitFullName(r: Record<string, unknown>): Record<string, unknown> {
  const [firstName, ...rest] = String(r['fullName'] ?? '').split(' ')
  return { id: r['id'], firstName, lastName: rest.join(' ') }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('migrateThenMerge', () => {
  // (a) Older-schema compartment migrates then merges
  it('(a) migrates an older-schema compartment to the receiver version, then merges', async () => {
    const { bundleBytes, transferKey } = await buildOldBundle()
    const receiver = await buildNewSchemaReceiver()

    const report = await migrateThenMerge(receiver, bundleBytes, {
      transferKey,
      fromVersion: 0,
      toVersion: 1,
      strategy: 'take-incoming',
      migrations: {
        clients: [{ toVersion: 1, transform: splitFullName }],
      },
    })

    expect(report.summary.inserted + report.summary.updated).toBeGreaterThan(0)
    const merged = await receiver.collection<NewClient>('clients').get('c1')
    expect(merged).not.toBeNull()
    expect(merged).toMatchObject({ firstName: 'Jane', lastName: 'Doe' })

    // migration metadata
    expect(report.migration.fromVersion).toBe(0)
    expect(report.migration.toVersion).toBe(1)
    expect(report.migration.byCollection['clients']).toBe('transformed')
  })

  // (b) Newer-than-receiver bundle refused with MinVersionError
  it('(b) refuses a newer-than-receiver bundle with an actionable MinVersionError', async () => {
    const { bundleBytes, transferKey } = await buildOldBundle()
    const receiver = await buildNewSchemaReceiver()

    await expect(
      migrateThenMerge(receiver, bundleBytes, {
        transferKey,
        fromVersion: 5,
        toVersion: 1,
        strategy: 'take-incoming',
      }),
    ).rejects.toThrow(MinVersionError)
  })

  // (c) Additive fast-path: no transform needed when old shape still validates
  it('(c) additive evolution merges with no transform supplied', async () => {
    const { bundleBytes, transferKey } = await buildSimpleBundle()
    const receiver = await buildAdditiveReceiver()

    // No migration steps — old shape { id, name } validates against { id, name, note? }
    const report = await migrateThenMerge(receiver, bundleBytes, {
      transferKey,
      fromVersion: 0,
      toVersion: 1,
      strategy: 'take-incoming',
    })

    // No MigrationTransformRequiredError was thrown; records merged
    expect(report.summary.total).toBeGreaterThan(0)
    expect(report.migration.byCollection['clients']).toBe('additive-no-transform')

    const c1 = await receiver.collection<SimpleClientWithNote>('clients').get('c1')
    expect(c1).not.toBeNull()
    expect(c1!.name).toBe('Alice')
  })

  // (d) Staging safety: non-additive drift + no transform → throws BEFORE any write
  it('(d) throws MigrationTransformRequiredError before writing when a transform is required', async () => {
    const { bundleBytes, transferKey } = await buildOldBundle()
    const receiver = await buildNewSchemaReceiver()

    // No migration steps supplied — incoming { id, fullName } fails schema { id, firstName, lastName }
    await expect(
      migrateThenMerge(receiver, bundleBytes, {
        transferKey,
        fromVersion: 0,
        toVersion: 1,
        strategy: 'take-incoming',
        // no migrations
      }),
    ).rejects.toThrow(MigrationTransformRequiredError)

    // Staging safety: receiver must be untouched — c1 was never written
    const c1 = await receiver.collection<NewClient>('clients').get('c1')
    expect(c1).toBeNull()
  })

  // (e) Same-version bundle merges directly
  it('(e) merges directly when fromVersion === toVersion (no migration)', async () => {
    const { bundleBytes, transferKey } = await buildSameVersionBundle()
    const receiver = await buildSameVersionReceiver()

    const report = await migrateThenMerge(receiver, bundleBytes, {
      transferKey,
      fromVersion: 0,
      toVersion: 0,
      strategy: 'take-incoming',
    })

    expect(report.summary.inserted).toBe(1)
    expect(report.migration.fromVersion).toBe(0)
    expect(report.migration.toVersion).toBe(0)
    expect(report.migration.byCollection['clients']).toBe('same-version')

    const c1 = await receiver.collection<SimpleClient>('clients').get('c1')
    expect(c1).not.toBeNull()
    expect(c1!.name).toBe('Alice')
  })

  // (f) Multi-step chain applies in ascending order; out-of-window steps excluded
  it('(f) applies a v0→v1→v2 chain in order and excludes steps above toVersion', async () => {
    const { bundleBytes, transferKey } = await buildOldBundle()
    const db = await createNoydb({ store: memory(), user: 'recv-chain', secret: 'recv-chain-secret-789' })
    const receiver = await db.openVault('receiver-chain')
    receiver.collection<{ id: string; firstName: string; lastName: string; display: string }>('clients', {
      schema: z.object({
        id: z.string(),
        firstName: z.string(),
        lastName: z.string(),
        display: z.string(),
      }),
    })

    const report = await migrateThenMerge(receiver, bundleBytes, {
      transferKey,
      fromVersion: 0,
      toVersion: 2,
      strategy: 'take-incoming',
      migrations: {
        clients: [
          // step 2 depends on step 1's output (firstName/lastName) — proves ordering
          { toVersion: 2, transform: (r) => ({ ...r, display: `${String(r['firstName'])} ${String(r['lastName'])}`.toUpperCase() }) },
          { toVersion: 1, transform: splitFullName },
          // out-of-window: toVersion 3 > target 2 → must be excluded (would overwrite display)
          { toVersion: 3, transform: (r) => ({ ...r, display: 'SHOULD-NOT-APPLY' }) },
        ],
      },
    })

    expect(report.migration.byCollection['clients']).toBe('transformed')
    const merged = await receiver.collection<{ id: string; firstName: string; lastName: string; display: string }>('clients').get('c1')
    expect(merged).toMatchObject({ firstName: 'Jane', lastName: 'Doe', display: 'JANE DOE' })
  })

  // (g) A transform that drops `id` cannot silently detach a row (id re-injected in staging).
  //     Uses a SCHEMALESS receiver — the exact path where validateInput would NOT catch it.
  it('(g) re-injects canonical id when a transform drops it (schemaless receiver)', async () => {
    const { bundleBytes, transferKey } = await buildSimpleBundle()
    const db = await createNoydb({ store: memory(), user: 'recv-idrop', secret: 'recv-idrop-secret-789' })
    const receiver = await db.openVault('receiver-idrop')

    const report = await migrateThenMerge(receiver, bundleBytes, {
      transferKey,
      fromVersion: 0,
      toVersion: 1,
      strategy: 'take-incoming',
      migrations: {
        // transform DROPS id entirely — without re-injection the merge would skip the row
        clients: [{ toVersion: 1, transform: (r) => ({ name: String(r['name']).toUpperCase() }) }],
      },
    })

    expect(report.summary.inserted).toBe(2)   // both rows merged, none silently lost
    const c1 = await receiver.collection<SimpleClient>('clients').get('c1')
    expect(c1).not.toBeNull()
    expect(c1!.name).toBe('ALICE')
    expect(c1!.id).toBe('c1')                 // canonical id preserved
  })
})
