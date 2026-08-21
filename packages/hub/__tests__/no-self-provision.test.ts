/**
 * #313 — openVault no-self-provision.
 *
 * Verifies that opening a vault you hold no grant to that is already
 * held by other principals fails closed (NoAccessError) and writes
 * NOTHING into the vault — including managed-secret mode where
 * resolveManagedSecret would otherwise persist _meta/sealed-secret
 * before the loadKeyring check fires.
 *
 * The pre-gate sits in getKeyringInternal BEFORE resolveManagedSecret
 * (not in the loadKeyring catch) specifically to prevent that write.
 */

import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, NoAccessError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import {
  MemorySealer,
} from '../src/with-party/team/managed-secret.js'
import { shamirRecoveryProvider } from '@noy-db/on-shamir'
import { withTeam } from '../src/with-party/team/index.js'

// Inline memory adapter (same shape as cross-vault.test.ts)
function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
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
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
    async listVaults() { return [...store.keys()] },
  }
}

/**
 * Wraps a NoydbStore adapter and tracks every (compartment/collection/id)
 * triple that is written via put(). Enables assertions like
 * "nothing was written after mark X".
 */
function trackingMemory() {
  const base = toMemory()
  const writes: string[] = []
  return {
    adapter: {
      ...base,
      async put(c: string, col: string, id: string, env: EncryptedEnvelope, ev?: number) {
        writes.push(`${c}/${col}/${id}`)
        return base.put(c, col, id, env, ev)
      },
      async saveAll(c: string, data: Record<string, Record<string, EncryptedEnvelope>>) {
        for (const [col, recs] of Object.entries(data))
          for (const id of Object.keys(recs)) writes.push(`${c}/${col}/${id}`)
        return base.saveAll(c, data)
      },
      async delete(c: string, col: string, id: string) {
        writes.push(`${c}/${col}/${id}:delete`)
        return base.delete(c, col, id)
      },
    } as NoydbStore,
    writesSince(mark: number) { return writes.slice(mark) },
    mark() { return writes.length },
  }
}

describe('openVault no-self-provision (#313)', () => {
  it('default: bob opening alice\'s populated vault fails closed and writes nothing', async () => {
    const { adapter, mark, writesSince } = trackingMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'alice-pass' })
    const av = await alice.openVault('client-1')
    await av.collection<{ n: number }>('c').put('r1', { n: 1 })

    const bob = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'bob', secret: 'bob-pass' })
    const m = mark()
    await expect(bob.openVault('client-1')).rejects.toBeInstanceOf(NoAccessError)
    expect(writesSince(m)).toEqual([])          // NOTHING written after alice populated the vault
    expect(await adapter.get('client-1', '_keyring', 'bob')).toBeNull()
  })

  it('MANAGED mode: bob (managed) opening alice\'s vault fails closed and writes no _meta/sealed-secret', async () => {
    const { adapter, mark, writesSince } = trackingMemory()

    // alice creates + populates with a standard secret-based vault
    const alice = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'alice-pass' })
    await (await alice.openVault('client-1')).collection<{ n: number }>('c').put('r1', { n: 1 })

    // bob uses managed mode — resolveManagedSecret would write _meta/sealed-secret
    // on first open if the pre-gate weren't there
    const bobProvider = new MemorySealer({ id: 'test-kms' })
    const bob = await createNoydb({ teamStrategy: withTeam(),
      store: adapter,
      user: 'bob',
      secretMode: 'managed',
      sealingKey: bobProvider,
      shamirRecovery: shamirRecoveryProvider(),
    })
    const m = mark()
    await expect(bob.openVault('client-1')).rejects.toBeInstanceOf(NoAccessError)
    // The pre-gate must fire BEFORE resolveManagedSecret, so no _meta/sealed-secret
    // or any other artifact is written into client-1.
    expect(writesSince(m)).toEqual([])          // nothing written — gate is before resolveManagedSecret
    expect(await adapter.get('client-1', '_meta', 'sealed-secret')).toBeNull()
  })

  it('new vault still open-or-creates (default)', async () => {
    const { adapter } = trackingMemory()
    const db = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'alice-pass' })
    const v = await db.openVault('fresh')
    await v.collection<{ n: number }>('c').put('r1', { n: 1 })
    expect(await adapter.get('fresh', '_keyring', 'alice')).not.toBeNull()
  })

  it('create:false never creates, even a fresh vault', async () => {
    const { adapter } = trackingMemory()
    const db = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'alice-pass' })
    await expect(db.openVault('fresh', { create: false })).rejects.toBeInstanceOf(NoAccessError)
    expect(await adapter.get('fresh', '_keyring', 'alice')).toBeNull()
  })

  it('create:false on a populated vault succeeds for a granted member', async () => {
    const { adapter } = trackingMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'alice-pass' })
    await (await alice.openVault('client-1')).collection<{ n: number }>('c').put('r1', { n: 1 })
    await alice.grant('client-1', { userId: 'bob', displayName: 'Bob', role: 'viewer', secret: 'bob-pass', allowWeakSecret: true })
    const bob = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'bob', secret: 'bob-pass' })
    const bv = await bob.openVault('client-1', { create: false })
    expect(await bv.collection<{ n: number }>('c').get('r1')).toEqual({ n: 1 })
  })

  it('a granted member opens fine and can read records', async () => {
    const { adapter } = trackingMemory()
    const alice = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'alice-pass' })
    await (await alice.openVault('client-1')).collection<{ n: number }>('c').put('r1', { n: 1 })
    await alice.grant('client-1', {
      userId: 'bob',
      displayName: 'Bob',
      role: 'viewer',
      secret: 'bob-pass',
      allowWeakSecret: true,
    })

    const bob = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'bob', secret: 'bob-pass' })
    const bv = await bob.openVault('client-1')
    expect(await bv.collection<{ n: number }>('c').get('r1')).toEqual({ n: 1 })
  })
})
