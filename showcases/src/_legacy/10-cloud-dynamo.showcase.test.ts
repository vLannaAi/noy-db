/**
 * Showcase 10 — "Cloud DynamoDB"
 * GitHub issue: https://github.com/vLannaAi/noy-db/issues/175
 *
 * Framework: Nuxt-style composables via `@noy-db/in-vue` (no Pinia)
 * Store:     `dynamo(...)` against real AWS
 * Pattern:   Local memory + remote DynamoDB sync-peer
 * Dimension: Cloud-synced — proves the single-table DynamoDB adapter works
 *            end-to-end through the normal app surface (useCollection) and
 *            that memory ↔ DynamoDB sync converges.
 *
 * SKIPPED BY DEFAULT.
 *
 * Runs only when `NOYDB_SHOWCASE_AWS_PROFILE=<profile-name>` is set in
 * `showcases/.env` (see `.env.example`). That profile supplies both
 * credentials and region to the AWS SDK — this file never touches raw
 * credentials.
 *
 * Prerequisites (one-time):
 *
 *   aws cloudformation deploy \
 *     --template-file showcases/cfn-showcase-table.yaml \
 *     --stack-name noydb-showcase \
 *     --profile <your-profile-name>
 *
 * Cleanup:
 *   - Per-test record cleanup runs in `afterAll` (controlled by
 *     `NOYDB_SHOWCASE_AWS_CLEANUP` — default ON).
 *   - Full stack teardown is always manual:
 *       aws cloudformation delete-stack --stack-name noydb-showcase
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { effectScope, nextTick, type EffectScope } from 'vue'
import { createNoydb, type Noydb, type NoydbStore } from '@noy-db/hub'
import { dynamo } from '@noy-db/to-aws-dynamo'
import { memory } from '@noy-db/to-memory'
import { useCollection, type UseCollectionReturn } from '@noy-db/in-vue'

import {
  type Invoice,
  sampleClients,
  SHOWCASE_PASSPHRASE,
} from '../_fixtures.js'
import {
  AWS_ENABLED,
  DYNAMO_TABLE,
  RUN_ID,
  cleanupVault,
  logSkipHint,
} from '../_aws.js'

logSkipHint('showcase-10')

const VAULT_NAME = `showcase-10-${RUN_ID}`

describe.skipIf(!AWS_ENABLED)('Showcase 10 — Cloud DynamoDB (Nuxt composables)', () => {
  let db: Noydb
  let remoteStore: NoydbStore
  let scope: EffectScope
  let invoices: UseCollectionReturn<Invoice>

  beforeAll(async () => {
    // `dynamo({ table })` builds its own DynamoDB client under the hood
    // using the SDK's default credential chain — which, thanks to the
    // `AWS_PROFILE` promotion in `_setup.ts`, resolves to the profile
    // named in `showcases/.env`. Region comes from the profile's config
    // entry, not from this file.
    remoteStore = dynamo({ table: DYNAMO_TABLE })

    db = await createNoydb({
      store: remoteStore,
      user: 'owner',
      secret: SHOWCASE_PASSPHRASE,
    })
    await db.openVault(VAULT_NAME)

    // effectScope gives `useCollection` a reactive-effect home so its
    // internal `onUnmounted(...)` cleanup runs when we call `scope.stop()`.
    // Without this, calling a composable outside a component context
    // leaks the `db.on('change', ...)` handler.
    scope = effectScope()
    invoices = scope.run(() => useCollection<Invoice>(db, VAULT_NAME, 'invoices'))!

    // Wait for the initial hydration (loading flips to false once the
    // first `refresh()` resolves).
    while (invoices.loading.value) {
      await nextTick()
      await new Promise((r) => setTimeout(r, 10))
    }
  }, 30_000)

  afterAll(async () => {
    try {
      // Close the composable's watcher first so the per-delete change
      // events don't kick off a storm of refreshes during teardown.
      scope?.stop()
    } catch { /* non-fatal */ }

    try {
      // Delete every record on this vault from the shared stores. The
      // helper respects NOYDB_SHOWCASE_AWS_CLEANUP=0 (leave in place for
      // inspection). System collections (`_keyring`, `_sync`) are
      // included so the DynamoDB partition is truly empty afterwards.
      await cleanupVault({
        label: 'showcase-10',
        vault: VAULT_NAME,
        stores: [
          { store: remoteStore, collections: ['invoices', '_keyring', '_sync'] },
        ],
      })
    } finally {
      db?.close()
    }
  }, 30_000)

  it('step 1 — empty vault hydrates with no records', () => {
    // Fresh namespace means there's nothing in DynamoDB for this vault
    // yet. useCollection should land on an empty reactive array, loading
    // already cleared in beforeAll.
    expect(invoices.loading.value).toBe(false)
    expect(invoices.error.value).toBeNull()
    expect(invoices.data.value).toEqual([])
  })

  it('step 2 — writes land in DynamoDB and reactivity reflects them', async () => {
    const vault = db.vault(VAULT_NAME)
    const coll = vault.collection<Invoice>('invoices')

    await coll.put('inv-cloud-001', {
      id: 'inv-cloud-001',
      clientId: sampleClients[0]!.id,
      amount: 21_500,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      month: '2026-04',
    })

    await coll.put('inv-cloud-002', {
      id: 'inv-cloud-002',
      clientId: sampleClients[1]!.id,
      amount: 9_000,
      currency: 'THB',
      status: 'open',
      issueDate: '2026-04-05',
      dueDate: '2026-05-05',
      month: '2026-04',
    })

    // useCollection listens to change events; give the refresh a tick
    // or two to settle. Poll rather than sleep-fixed because DynamoDB
    // latency varies per region.
    await waitFor(() => invoices.data.value.length === 2, 5_000)
    expect(invoices.data.value.map((i) => i.id).sort()).toEqual([
      'inv-cloud-001',
      'inv-cloud-002',
    ])

    // Round-trip check: the raw DynamoDB envelope is ciphertext. No
    // plaintext amount ("21500") in the _data blob.
    const raw = await remoteStore.get(VAULT_NAME, 'invoices', 'inv-cloud-001')
    expect(raw).toBeTruthy()
    expect(raw!._noydb).toBe(1)
    expect(typeof raw!._data).toBe('string')
    expect(typeof raw!._iv).toBe('string')
    expect(raw!._data).not.toContain('21500')
  })

  it('step 3 — memory ↔ DynamoDB sync converges', async () => {
    // Spin up a *second* NOYDB instance whose primary store is an
    // in-memory store and whose sync-peer is the same DynamoDB table.
    // This is the offline-first client shape — reads/writes hit memory
    // instantly, then `pull`/`push` reconcile with the cloud.
    const localMemory = memory()
    const localDb = await createNoydb({
      store: localMemory,
      sync: [{ store: dynamo({ table: DYNAMO_TABLE }), role: 'sync-peer' }],
      user: 'owner',
      secret: SHOWCASE_PASSPHRASE,
    })
    try {
      await localDb.openVault(VAULT_NAME)

      // Pull everything the cloud knows about this vault into local memory.
      const pullResult = await localDb.pull(VAULT_NAME)
      expect(pullResult).toBeTruthy()

      const localColl = localDb
        .vault(VAULT_NAME)
        .collection<Invoice>('invoices')
      const pulled = await localColl.list()
      expect(pulled.map((i) => i.id).sort()).toEqual([
        'inv-cloud-001',
        'inv-cloud-002',
      ])

      // Add a locally-originated invoice, push, and confirm the cloud
      // instance's composable picks it up.
      await localColl.put('inv-cloud-003', {
        id: 'inv-cloud-003',
        clientId: sampleClients[2]!.id,
        amount: 33_000,
        currency: 'THB',
        status: 'open',
        issueDate: '2026-04-10',
        dueDate: '2026-05-10',
        month: '2026-04',
      })

      await localDb.push(VAULT_NAME)

      // Force the cloud-side composable to re-read — the sync engine
      // on the cloud instance wasn't involved in this write, so its
      // change-event handler won't fire automatically.
      await invoices.refresh()
      expect(invoices.data.value.map((i) => i.id).sort()).toEqual([
        'inv-cloud-001',
        'inv-cloud-002',
        'inv-cloud-003',
      ])
    } finally {
      localDb.close()
    }
  })

  it('step 4 — recap: deletes propagate through the reactive surface', async () => {
    const coll = db.vault(VAULT_NAME).collection<Invoice>('invoices')
    await coll.delete('inv-cloud-002')

    await waitFor(
      () => !invoices.data.value.some((i) => i.id === 'inv-cloud-002'),
      5_000,
    )
    expect(invoices.data.value.map((i) => i.id).sort()).toEqual([
      'inv-cloud-001',
      'inv-cloud-003',
    ])
  })
})

/**
 * Poll-based waiter. DynamoDB writes are durable but the reactive
 * refresh is async — we'd rather wait for the real condition than paper
 * over latency with a fixed `sleep()`.
 */
async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}
