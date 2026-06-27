import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { effectScope, nextTick } from 'vue'
import {
  createNoydb,
  ConflictError,
  type Noydb,
  type NoydbStore,
  type EncryptedEnvelope,
  type VaultSnapshot,
} from '@noy-db/hub'
import {
  setActiveNoydb,
  useCapabilityGrant,
  CAPABILITY_REQUESTS_COLLECTION,
  type CapabilityGrantRecord,
} from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

const SECRET = 'cap-grant-test-passphrase-2026'

let db: Noydb

async function freshDb(): Promise<Noydb> {
  return createNoydb({
    store: memory(),
    user: 'admin-user',
    secret: SECRET,
  })
}

beforeEach(async () => {
  setActivePinia(createPinia())
  db = await freshDb()
  setActiveNoydb(db)
})

afterEach(() => {
  setActiveNoydb(null)
})

describe('useCapabilityGrant', () => {
  it('1. request → approve → release lifecycle drives the state machine', async () => {
    const vault = await db.openVault('V1')
    void vault
    const scope = effectScope()
    const grant = scope.run(() =>
      useCapabilityGrant('canExportPlaintext', {
        vault: 'V1',
        ttlMs: 60_000,
        approver: 'owner',
        reason: 'bulk export',
      }),
    )!
    expect(grant.state.value).toBe('idle')
    expect(grant.timeRemaining.value).toBe(0)

    await grant.request()
    expect(grant.state.value).toBe('requested')
    expect(grant.timeRemaining.value).toBe(0)

    await grant.approve()
    expect(grant.state.value).toBe('granted')
    expect(grant.timeRemaining.value).toBeGreaterThan(0)
    expect(grant.timeRemaining.value).toBeLessThanOrEqual(60_000)

    await grant.release()
    expect(grant.state.value).toBe('idle')
    expect(grant.timeRemaining.value).toBe(0)

    scope.stop()
  })

  it('2. request persists a record with metadata only (no plaintext payload)', async () => {
    const vault = await db.openVault('V1')
    const scope = effectScope()
    const grant = scope.run(() =>
      useCapabilityGrant('canExportPlaintext', {
        vault: 'V1',
        ttlMs: 60_000,
        approver: 'owner',
        reason: 'bulk export',
      }),
    )!
    await grant.request()
    await grant.approve()

    const coll = vault.collection<CapabilityGrantRecord>(CAPABILITY_REQUESTS_COLLECTION)
    const ids = await coll.list()
    expect(ids).toHaveLength(1)
    const record = ids[0]
    expect(record).toBeDefined()
    // Only metadata fields — no record payload bleeds in.
    const stored = record!
    expect(stored.capability).toBe('canExportPlaintext')
    expect(stored.requestedBy).toBe('admin-user')
    expect(stored.approvedBy).toBe('admin-user')
    expect(stored.reason).toBe('bulk export')
    expect(stored.ttlMs).toBe(60_000)
    expect(stored.status).toBe('granted')
    expect(stored.expiresAt).toBeTruthy()

    scope.stop()
  })

  it('3. TTL expiry flips state to idle and calls onRelease with cause: expired', async () => {
    const vault = await db.openVault('V1')
    void vault
    const releases: string[] = []
    const scope = effectScope()
    const grant = scope.run(() =>
      useCapabilityGrant('canExportPlaintext', {
        vault: 'V1',
        ttlMs: 30,
        approver: 'owner',
        reason: 'short ttl',
        onRelease: ({ cause }) => { releases.push(cause) },
      }),
    )!
    await grant.request()
    await grant.approve()
    expect(grant.state.value).toBe('granted')

    await new Promise((r) => setTimeout(r, 60))
    expect(grant.state.value).toBe('idle')
    expect(releases).toEqual(['expired'])

    scope.stop()
  })

  it('4. onGrant callback fires on approve, onRelease on voluntary release', async () => {
    const calls: string[] = []
    const scope = effectScope()
    const grant = scope.run(() =>
      useCapabilityGrant('canExportPlaintext', {
        vault: 'V1',
        ttlMs: 60_000,
        approver: 'owner',
        reason: 'r',
        onGrant: () => { calls.push('grant') },
        onRelease: ({ cause }) => { calls.push(`release:${cause}`) },
      }),
    )!
    await grant.request()
    await grant.approve()
    expect(calls).toEqual(['grant'])

    await grant.release()
    expect(calls).toEqual(['grant', 'release:released'])

    scope.stop()
  })

  it('5. approve rejects when the caller role does not match approver', async () => {
    // Set up a non-owner session: re-grant the active user as operator.
    // Owner can always approve; operator on an admin-required grant cannot.
    const adapter = memory()
    const ownerDb = await createNoydb({ store: adapter, user: 'owner', secret: SECRET })
    await ownerDb.openVault('V1')
    await ownerDb.grant('V1', {
      userId: 'op',
      displayName: 'Op',
      role: 'operator',
      passphrase: 'op-pw',
      permissions: { [CAPABILITY_REQUESTS_COLLECTION]: 'rw' },
    })
    await ownerDb.close()

    const opDb = await createNoydb({ store: adapter, user: 'op', secret: 'op-pw' })
    setActiveNoydb(opDb)
    await opDb.openVault('V1')

    const scope = effectScope()
    const grant = scope.run(() =>
      useCapabilityGrant('canExportPlaintext', {
        vault: 'V1',
        ttlMs: 60_000,
        approver: 'admin',  // requires admin or owner
        reason: 'r',
      }),
    )!
    await grant.request()
    await expect(grant.approve()).rejects.toThrow(/cannot approve/)
    expect(grant.state.value).toBe('requested') // unchanged
    scope.stop()
  })

  it('6. cannot request from non-idle state', async () => {
    const scope = effectScope()
    const grant = scope.run(() =>
      useCapabilityGrant('canExportPlaintext', {
        vault: 'V1',
        ttlMs: 60_000,
        approver: 'owner',
        reason: 'r',
      }),
    )!
    await grant.request()
    await expect(grant.request()).rejects.toThrow(/cannot request from state/)
    scope.stop()
  })

  it('7. release from non-granted state is a no-op (does not throw)', async () => {
    const scope = effectScope()
    const grant = scope.run(() =>
      useCapabilityGrant('canExportPlaintext', {
        vault: 'V1',
        ttlMs: 60_000,
        approver: 'owner',
        reason: 'r',
      }),
    )!
    await expect(grant.release()).resolves.toBeUndefined()
    expect(grant.state.value).toBe('idle')

    await grant.request()
    await expect(grant.release()).resolves.toBeUndefined() // requested → no-op too
    expect(grant.state.value).toBe('requested')
    scope.stop()
  })

  it('8. scope dispose clears the expiry timer + change subscription', async () => {
    const vault = await db.openVault('V1')
    void vault
    const releases: string[] = []
    const scope = effectScope()
    const grant = scope.run(() =>
      useCapabilityGrant('canExportPlaintext', {
        vault: 'V1',
        ttlMs: 30,
        approver: 'owner',
        reason: 'r',
        onRelease: ({ cause }) => { releases.push(cause) },
      }),
    )!
    await grant.request()
    await grant.approve()

    scope.stop()
    // Without the scope-dispose teardown, the expiry timer would still
    // fire and onRelease would be called. With the teardown, neither.
    await new Promise((r) => setTimeout(r, 60))
    expect(releases).toEqual([])
  })

  it('9. composable is a no-op in non-browser hosts (window undefined)', async () => {
    const savedWindow = (globalThis as { window?: unknown }).window
    Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true })
    try {
      const scope = effectScope()
      const grant = scope.run(() =>
        useCapabilityGrant('canExportPlaintext', {
          vault: 'V1',
          ttlMs: 60_000,
          approver: 'owner',
          reason: 'r',
        }),
      )!
      // request() does nothing in SSR — state stays idle, no record persisted.
      await grant.request()
      expect(grant.state.value).toBe('idle')
      scope.stop()
    } finally {
      Object.defineProperty(globalThis, 'window', { value: savedWindow, configurable: true })
    }
  })

  // The change-stream cross-session visibility is exercised indirectly
  // by tests 1-4 (the same composable instance writes and observes its
  // own record). Real cross-session integration requires the sync
  // engine and is out of scope for the in-pinia composable's unit tests.
  it('10. timeRemaining is reactive to time progressing', async () => {
    vi.useFakeTimers()
    try {
      const scope = effectScope()
      const grant = scope.run(() =>
        useCapabilityGrant('canExportPlaintext', {
          vault: 'V1',
          ttlMs: 60_000,
          approver: 'owner',
          reason: 'r',
        }),
      )!
      await grant.request()
      await grant.approve()
      const initial = grant.timeRemaining.value

      vi.advanceTimersByTime(2000)
      await nextTick()
      expect(grant.timeRemaining.value).toBeLessThan(initial)
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
