/**
 * Showcase 06 — "Cascade-delete / FK integrity"
 * GitHub issue: https://github.com/vLannaAi/noy-db/issues/171
 *
 * Framework: Nuxt + Pinia (the runtime here is just Pinia — Nuxt context
 *            is a build-time concern, not a test-time one).
 * Store:     `memory()`
 * Branch:    showcase/06-cascade-delete-fk
 * Dimension: Data integrity, FK relationships, Pinia reactivity
 *
 * What this proves:
 *   1. `ref('clients', 'warn')` declares a soft foreign key on the
 *      invoices collection without blocking writes or deletes.
 *   2. `vault.checkIntegrity()` walks every collection's declared refs
 *      and reports orphans as a `RefViolation[]` — the sync surface a
 *      UI would render as "these invoices are dangling".
 *   3. The query-time join picks up the same `'warn'` mode from the
 *      ref declaration: `.join('clientId', { as: 'client' })` attaches
 *      `client: null` on orphan FKs instead of throwing.
 *   4. Fixing the orphans (reassigning FKs to a live client) brings
 *      `checkIntegrity()` back to a clean slate — no code change needed
 *      because refs are declared, not enforced-at-write in warn mode.
 *
 * Refs are declared on the underlying `Collection` at vault-level
 * (the Pinia store's `add/update/remove` then inherit the behavior
 * via the shared collection cache). That mirrors how a Nuxt plugin
 * would wire things: open the vault once at `app.vue`, declare the
 * collection metadata, and every Pinia store that calls
 * `defineNoydbStore('invoices', { vault: 'firm-demo' })` picks up the
 * cached ref-aware collection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  createNoydb,
  ref as refFk,
  type Noydb,
  type Vault,
} from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { defineNoydbStore, setActiveNoydb } from '@noy-db/in-pinia'

import {
  type Invoice,
  type Client,
  sampleClients,
  SHOWCASE_PASSPHRASE,
} from '../_fixtures.js'

describe('Showcase 06 — Cascade-delete / FK integrity (Pinia)', () => {
  let db: Noydb
  let vault: Vault
  let clientsStore: ReturnType<ReturnType<typeof defineNoydbStore<Client>>>
  let invoicesStore: ReturnType<ReturnType<typeof defineNoydbStore<Invoice>>>

  beforeEach(async () => {
    setActivePinia(createPinia())

    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: SHOWCASE_PASSPHRASE,
    })
    vault = await db.openVault('firm-demo')

    // Declare the ref descriptors BEFORE the Pinia stores hydrate.
    // Collections are cached per-vault, so when `defineNoydbStore`
    // later calls `vault.collection('invoices')` it hits the cache
    // and picks up the ref-aware instance we configured here.
    vault.collection<Client>('clients')
    vault.collection<Invoice>('invoices', {
      refs: {
        // 'warn' mode: writes/deletes never throw; orphans surface
        // through checkIntegrity() and through .join() with null.
        clientId: refFk('clients', 'warn'),
      },
    })

    setActiveNoydb(db)

    const useClients = defineNoydbStore<Client>('clients', { vault: 'firm-demo' })
    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'firm-demo' })
    clientsStore = useClients()
    invoicesStore = useInvoices()
    await Promise.all([clientsStore.$ready, invoicesStore.$ready])
  })

  afterEach(async () => {
    setActiveNoydb(null)
    await db.close()
  })

  it('step 1 — clean slate: two clients, two invoices, no violations', async () => {
    // Add two clients and two invoices pointing at them.
    await clientsStore.add(sampleClients[0].id, sampleClients[0])
    await clientsStore.add(sampleClients[1].id, sampleClients[1])

    await invoicesStore.add('inv-001', {
      id: 'inv-001',
      clientId: sampleClients[0].id,
      amount: 12_500,
      currency: 'THB',
      status: 'open',
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      month: '2026-04',
    })
    await invoicesStore.add('inv-002', {
      id: 'inv-002',
      clientId: sampleClients[1].id,
      amount: 8_000,
      currency: 'THB',
      status: 'open',
      issueDate: '2026-04-05',
      dueDate: '2026-05-05',
      month: '2026-04',
    })

    const { violations } = await vault.checkIntegrity()
    expect(violations).toEqual([])
  })

  it('step 2 — deleting a referenced client surfaces a violation (warn mode)', async () => {
    // Seed clients + invoices.
    await clientsStore.add(sampleClients[0].id, sampleClients[0])
    await clientsStore.add(sampleClients[1].id, sampleClients[1])
    await invoicesStore.add('inv-001', {
      id: 'inv-001', clientId: sampleClients[0].id, amount: 12_500,
      currency: 'THB', status: 'open',
      issueDate: '2026-04-01', dueDate: '2026-05-01', month: '2026-04',
    })
    await invoicesStore.add('inv-002', {
      id: 'inv-002', clientId: sampleClients[1].id, amount: 8_000,
      currency: 'THB', status: 'open',
      issueDate: '2026-04-05', dueDate: '2026-05-05', month: '2026-04',
    })

    // Warn mode lets the delete succeed — strict mode would have thrown.
    await clientsStore.remove(sampleClients[0].id)

    // `checkIntegrity()` walks every collection's declared refs and
    // reports the orphan FK. The returned shape lines up with what a
    // devtools panel would render: collection, id, field, target, mode.
    const { violations } = await vault.checkIntegrity()
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      collection: 'invoices',
      id: 'inv-001',
      field: 'clientId',
      refTo: 'clients',
      refId: sampleClients[0].id,
      mode: 'warn',
    })
  })

  it('step 3 — .join() on a dangling FK attaches null (warn mode)', async () => {
    await clientsStore.add(sampleClients[0].id, sampleClients[0])
    await clientsStore.add(sampleClients[1].id, sampleClients[1])
    await invoicesStore.add('inv-001', {
      id: 'inv-001', clientId: sampleClients[0].id, amount: 12_500,
      currency: 'THB', status: 'open',
      issueDate: '2026-04-01', dueDate: '2026-05-01', month: '2026-04',
    })
    await invoicesStore.add('inv-002', {
      id: 'inv-002', clientId: sampleClients[1].id, amount: 8_000,
      currency: 'THB', status: 'open',
      issueDate: '2026-04-05', dueDate: '2026-05-05', month: '2026-04',
    })
    await clientsStore.remove(sampleClients[0].id) // inv-001 now orphaned

    // The `as: 'client'` projection attaches the joined row as
    // `client`. Because the ref was declared in warn mode, the
    // orphan's `client` becomes null and the query does NOT throw.
    // Suppress the one-shot console.warn from join so the test output
    // stays clean — the warn is documentation, not the assertion.
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const rows = invoicesStore
        .query()
        .join<'client', Client>('clientId', { as: 'client' })
        .toArray()

      expect(rows).toHaveLength(2)
      const orphan = rows.find(r => r.id === 'inv-001')!
      const alive = rows.find(r => r.id === 'inv-002')!
      expect(orphan.client).toBeNull()
      expect(alive.client?.id).toBe(sampleClients[1].id)
    } finally {
      console.warn = originalWarn
    }
  })

  it('step 4 — fixing the orphans returns checkIntegrity to clean', async () => {
    await clientsStore.add(sampleClients[0].id, sampleClients[0])
    await clientsStore.add(sampleClients[1].id, sampleClients[1])
    await invoicesStore.add('inv-001', {
      id: 'inv-001', clientId: sampleClients[0].id, amount: 12_500,
      currency: 'THB', status: 'open',
      issueDate: '2026-04-01', dueDate: '2026-05-01', month: '2026-04',
    })
    await invoicesStore.add('inv-002', {
      id: 'inv-002', clientId: sampleClients[1].id, amount: 8_000,
      currency: 'THB', status: 'open',
      issueDate: '2026-04-05', dueDate: '2026-05-05', month: '2026-04',
    })
    await clientsStore.remove(sampleClients[0].id)

    // Confirm we start with one orphan…
    const before = await vault.checkIntegrity()
    expect(before.violations).toHaveLength(1)

    // Reassign the orphaned invoice to a live client (any UI would
    // show the list of options from `clientsStore.items` here).
    const orphan = invoicesStore.byId('inv-001')!
    await invoicesStore.update('inv-001', {
      ...orphan,
      clientId: sampleClients[1].id,
    })

    // …and after the fix, integrity is clean.
    const after = await vault.checkIntegrity()
    expect(after.violations).toEqual([])
  })
})
