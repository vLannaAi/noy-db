/**
 * Showcase 03 — Store Routing (v0.12 #162/#163)
 * GitHub issue: https://github.com/vLannaAi/noy-db/issues/168
 *
 * Framework: Node.js (pure hub, no framework glue)
 * Store:     `routeStore({ default, routes: { audit } })`
 * Pattern:   Store multiplexing (see docs/guides/topology-matrix.md, v0.12)
 * Dimension: Extreme versatility — one logical Noydb fronting many backends
 *
 * What this proves:
 *   1. `routeStore` is a drop-in `NoydbStore` — passes straight into
 *      `createNoydb({ store })` with no other changes.
 *   2. Collection-level routing works: writes to `invoices` land on the
 *      `default` backing store; writes to `audit` land on the `audit`
 *      backing store. The two stores are physically separate Maps and
 *      neither sees the other's ciphertext.
 *   3. `override()` / `clearOverride()` hot-swap a backing store at
 *      runtime, without tearing down the Noydb instance.
 *   4. `suspend({ queue: true })` / `resume()` buffer writes during an
 *      outage and replay them when the route comes back. Reads during
 *      suspension return empty (null-store behaviour) but writes are
 *      not lost.
 *   5. `routeStatus()` exposes live diagnostics — which routes are
 *      overridden, which are suspended, how many writes are queued.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createNoydb,
  routeStore,
  type Noydb,
  type RoutedNoydbStore,
} from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

import {
  type Invoice,
  sampleClients,
  SHOWCASE_PASSPHRASE,
} from '../_fixtures.js'

/**
 * Minimal audit record — the "other" collection that gets routed to a
 * dedicated backing store. Kept inline because it's only used here.
 */
interface AuditEntry {
  id: string
  actor: string
  action: string
  targetId: string
  at: string // ISO-8601
}

const VAULT = 'firm-demo'

describe('Showcase 03 — Store Routing (routeStore)', () => {
  let defaultStore: ReturnType<typeof memory>
  let auditStore: ReturnType<typeof memory>
  let routed: RoutedNoydbStore
  let db: Noydb

  beforeEach(async () => {
    // Two independent backing stores — we keep direct references so
    // later steps can peek at each one and prove the routing worked.
    defaultStore = memory()
    auditStore = memory()

    routed = routeStore({
      default: defaultStore,
      routes: { audit: auditStore },
    })

    db = await createNoydb({
      store: routed,
      user: 'alice',
      secret: SHOWCASE_PASSPHRASE,
    })
    await db.openVault(VAULT)
  })

  afterEach(async () => {
    await db.close()
  })

  it('step 1 — invoices land on default, audit lands on audit store', async () => {
    // Application code is oblivious to routing — it just talks to
    // collections. The router picks the backend.
    const invoices = db.vault(VAULT).collection<Invoice>('invoices')
    const audit = db.vault(VAULT).collection<AuditEntry>('audit')

    await invoices.put('inv-001', {
      id: 'inv-001',
      clientId: sampleClients[0].id,
      amount: 12_500,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      month: '2026-04',
    })

    await audit.put('evt-001', {
      id: 'evt-001',
      actor: 'alice',
      action: 'create-invoice',
      targetId: 'inv-001',
      at: '2026-04-01T09:00:00.000Z',
    })

    // Peek at the backing stores directly — this is the whole point
    // of step 1. `invoices` is in default, not in audit; `audit` is
    // in audit, not in default.
    const defaultSnap = await defaultStore.loadAll(VAULT)
    const auditSnap = await auditStore.loadAll(VAULT)

    expect(Object.keys(defaultSnap)).toContain('invoices')
    expect(Object.keys(defaultSnap)).not.toContain('audit')
    expect(defaultSnap.invoices['inv-001']).toBeDefined()

    expect(Object.keys(auditSnap)).toContain('audit')
    expect(Object.keys(auditSnap)).not.toContain('invoices')
    expect(auditSnap.audit['evt-001']).toBeDefined()
  })

  it('step 2 — reads from routed store transparently find records in either backend', async () => {
    // The application never needs to know which backend a record lives
    // on — `collection.get()` works the same for both.
    const invoices = db.vault(VAULT).collection<Invoice>('invoices')
    const audit = db.vault(VAULT).collection<AuditEntry>('audit')

    await invoices.put('inv-002', {
      id: 'inv-002',
      clientId: sampleClients[1].id,
      amount: 8_000,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-05',
      dueDate: '2026-05-05',
      month: '2026-04',
    })
    await audit.put('evt-002', {
      id: 'evt-002',
      actor: 'alice',
      action: 'create-invoice',
      targetId: 'inv-002',
      at: '2026-04-05T09:00:00.000Z',
    })

    expect((await invoices.get('inv-002'))?.amount).toBe(8_000)
    expect((await audit.get('evt-002'))?.actor).toBe('alice')
  })

  it('step 3 — override() hot-swaps the default backing store at runtime', async () => {
    const invoices = db.vault(VAULT).collection<Invoice>('invoices')

    await invoices.put('inv-a', {
      id: 'inv-a',
      clientId: sampleClients[0].id,
      amount: 1_000,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      month: '2026-04',
    })

    // Swap the `default` route to a fresh memory store without hydrating.
    // Any writes after this point land on the new backend; reads for
    // the old record return null from the override (we didn't copy).
    const replacement = memory()
    routed.override('default', replacement, { hydrate: false })

    await invoices.put('inv-b', {
      id: 'inv-b',
      clientId: sampleClients[1].id,
      amount: 2_000,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-02',
      dueDate: '2026-05-02',
      month: '2026-04',
    })

    // The new backing store has inv-b but not inv-a — the override
    // was non-hydrating, so the earlier record stays on the original
    // default store.
    const replacementSnap = await replacement.loadAll(VAULT)
    expect(Object.keys(replacementSnap.invoices ?? {})).toContain('inv-b')
    expect(Object.keys(replacementSnap.invoices ?? {})).not.toContain('inv-a')

    // Original default still has inv-a but not inv-b.
    const originalSnap = await defaultStore.loadAll(VAULT)
    expect(Object.keys(originalSnap.invoices ?? {})).toContain('inv-a')
    expect(Object.keys(originalSnap.invoices ?? {})).not.toContain('inv-b')

    // routeStatus reports the active override.
    const statusDuring = routed.routeStatus()
    expect(statusDuring.overrides).toHaveProperty('default')

    // Revert the override — new writes go back to the original store.
    routed.clearOverride('default')
    await invoices.put('inv-c', {
      id: 'inv-c',
      clientId: sampleClients[2].id,
      amount: 3_000,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-03',
      dueDate: '2026-05-03',
      month: '2026-04',
    })
    const reverted = await defaultStore.loadAll(VAULT)
    expect(Object.keys(reverted.invoices ?? {})).toContain('inv-c')

    const statusAfter = routed.routeStatus()
    expect(statusAfter.overrides).not.toHaveProperty('default')
  })

  it('step 4 — suspend({ queue: true }) buffers writes; resume() replays them', async () => {
    const audit = db.vault(VAULT).collection<AuditEntry>('audit')

    // Simulate: the audit backend is temporarily unreachable.
    // We want writes to succeed from the app's perspective and be
    // replayed once the backend comes back.
    routed.suspend('audit', { queue: true })

    const statusSuspended = routed.routeStatus()
    expect(statusSuspended.suspended).toContain('audit')

    // These writes all land in the in-memory queue — not the backing
    // store. The call resolves successfully though (no exception).
    await audit.put('evt-q1', {
      id: 'evt-q1', actor: 'alice', action: 'login',
      targetId: '-', at: '2026-04-10T08:00:00.000Z',
    })
    await audit.put('evt-q2', {
      id: 'evt-q2', actor: 'alice', action: 'view-invoice',
      targetId: 'inv-001', at: '2026-04-10T08:01:00.000Z',
    })

    // Backing store is still empty — writes are buffered.
    const beforeResume = await auditStore.loadAll(VAULT)
    expect(beforeResume.audit?.['evt-q1']).toBeUndefined()
    expect(beforeResume.audit?.['evt-q2']).toBeUndefined()

    // routeStatus shows queue depth > 0 for the suspended route.
    const statusMid = routed.routeStatus()
    expect(statusMid.queued.audit).toBeGreaterThanOrEqual(2)

    // Resume — the queued writes are replayed against the now-live store.
    const replayed = await routed.resume('audit')
    expect(replayed).toBeGreaterThanOrEqual(2)

    const afterResume = await auditStore.loadAll(VAULT)
    expect(afterResume.audit?.['evt-q1']).toBeDefined()
    expect(afterResume.audit?.['evt-q2']).toBeDefined()

    // Queue is drained; suspended set no longer contains 'audit'.
    const statusDone = routed.routeStatus()
    expect(statusDone.suspended).not.toContain('audit')
  })

  it('step 5 — recap: one Noydb, multiple backends, zero app-level coupling', async () => {
    // The whole motivation for routeStore is "pick the right storage
    // for the job without telling the app". We re-prove the
    // separation here with a direct cross-check: write to each
    // collection, then confirm each backend holds only its own slice.
    const invoices = db.vault(VAULT).collection<Invoice>('invoices')
    const audit = db.vault(VAULT).collection<AuditEntry>('audit')

    await invoices.put('recap-inv', {
      id: 'recap-inv', clientId: sampleClients[0].id, amount: 99,
      currency: 'THB', status: 'draft',
      issueDate: '2026-04-20', dueDate: '2026-05-20', month: '2026-04',
    })
    await audit.put('recap-evt', {
      id: 'recap-evt', actor: 'alice', action: 'close-day',
      targetId: '-', at: '2026-04-20T18:00:00.000Z',
    })

    const defSnap = await defaultStore.loadAll(VAULT)
    const audSnap = await auditStore.loadAll(VAULT)

    // defaultStore holds invoices (and blob/keyring internals), but no audit.
    expect(defSnap.invoices?.['recap-inv']).toBeDefined()
    expect(defSnap.audit).toBeUndefined()

    // auditStore holds audit only — no invoices.
    expect(audSnap.audit?.['recap-evt']).toBeDefined()
    expect(audSnap.invoices).toBeUndefined()
  })
})
