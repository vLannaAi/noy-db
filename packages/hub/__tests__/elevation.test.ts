/**
 * Tests for `vault.elevate()` scoped tier-elevated handles (#283).
 *
 * Covers all 6 acceptance criteria:
 *   1. handle writes persist at the elevated tier
 *   2. TTL expiry flips writes to throw, reads on origin keep working
 *   3. audit ledger records each elevation as a distinct event
 *   4. nested elevation rejects with AlreadyElevatedError
 *   5. elevation to an unreachable tier rejects with TierNotGrantedError
 *   6. release() before TTL is idempotent; release after expiry is a no-op
 */

import { describe, it, expect } from 'vitest'
import {
  createNoydb,
  AlreadyElevatedError,
  ElevationExpiredError,
  TierNotGrantedError,
  ELEVATION_AUDIT_COLLECTION,
  ConflictError,
  type NoydbStore,
  type EncryptedEnvelope,
  type VaultSnapshot,
  type CrossTierAccessEvent,
} from '../src/index.js'

interface Doc {
  id: string
  title: string
  body: string
}

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, snap) {
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      data.set(v, vm)
    },
  }
}

async function ownerVault() {
  const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
  const vault = await db.openVault('v1')
  return { db, vault }
}

describe('vault.elevate (#283)', () => {
  it('1. writes through the handle persist at the elevated tier', async () => {
    const { vault } = await ownerVault()
    vault.collection<Doc>('docs', { tiers: [0, 1, 2] })

    const elev = await vault.elevate(2, { ttlMs: 60_000, reason: 'plaintext export' })
    await elev.collection<Doc>('docs').put('d1', { id: 'd1', title: 'Top', body: 'secret' })

    // The record came back at tier-2 — confirm via the existing
    // tier-aware read path on the original vault.
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1, 2] })
    const out = await docs.getAtTier('d1')
    expect(out).toEqual({ id: 'd1', title: 'Top', body: 'secret' })
    await elev.release()
  })

  it('2. cross-tier event stamps `authorization: elevation` plus reason + elevatedFrom', async () => {
    const { vault } = await ownerVault()
    vault.collection<Doc>('docs', { tiers: [0, 1, 2] })
    const events: CrossTierAccessEvent[] = []
    vault.onCrossTierAccess((e) => events.push(e))

    const elev = await vault.elevate(2, { ttlMs: 60_000, reason: 'plaintext export' })
    await elev.collection<Doc>('docs').put('d1', { id: 'd1', title: 'T', body: 'B' })
    await elev.release()

    expect(events).toHaveLength(1)
    expect(events[0]?.authorization).toBe('elevation')
    expect(events[0]?.tier).toBe(2)
    expect(events[0]?.reason).toBe('plaintext export')
    expect(events[0]?.elevatedFrom).toBe(0)
  })

  it('3. TTL expiry: writes flip to ElevationExpiredError; reads on origin keep working', async () => {
    const { vault } = await ownerVault()
    vault.collection<Doc>('docs', { tiers: [0, 1, 2] })

    const elev = await vault.elevate(2, { ttlMs: 5, reason: 'short ttl' })
    await new Promise((r) => setTimeout(r, 25))

    await expect(
      elev.collection<Doc>('docs').put('d1', { id: 'd1', title: 'T', body: 'B' }),
    ).rejects.toBeInstanceOf(ElevationExpiredError)

    // Origin vault read still works — elevation didn't tear it down.
    const docs = vault.collection<Doc>('docs')
    expect(await docs.list()).toEqual([])
  })

  it('4. audit ledger writes one envelope per elevation', async () => {
    const { db, vault } = await ownerVault()
    vault.collection<Doc>('docs', { tiers: [0, 1, 2] })

    const e1 = await vault.elevate(2, { ttlMs: 60_000, reason: 'r1' })
    await e1.release()
    const e2 = await vault.elevate(1, { ttlMs: 60_000, reason: 'r2' })
    await e2.release()

    const store = (db as unknown as { options: { store: NoydbStore } }).options.store
    const ids = await store.list('v1', ELEVATION_AUDIT_COLLECTION)
    expect(ids).toHaveLength(2)
    // Each entry encrypts under the audit collection's DEK; presence
    // is the assertion. Decrypting would require getDEK on internals
    // we don't expose — the metadata-only check above suffices for
    // "distinct event per elevation."
  })

  it('5. nested elevation rejects with AlreadyElevatedError', async () => {
    const { vault } = await ownerVault()
    vault.collection<Doc>('docs', { tiers: [0, 1, 2] })

    const e1 = await vault.elevate(2, { ttlMs: 60_000, reason: 'a' })
    await expect(
      vault.elevate(1, { ttlMs: 60_000, reason: 'b' }),
    ).rejects.toBeInstanceOf(AlreadyElevatedError)
    await e1.release()
    // Now a fresh elevation succeeds.
    const e2 = await vault.elevate(1, { ttlMs: 60_000, reason: 'b' })
    await e2.release()
  })

  it('6. release() is idempotent; release after expiry is a no-op', async () => {
    const { vault } = await ownerVault()
    vault.collection<Doc>('docs', { tiers: [0, 1, 2] })

    const e1 = await vault.elevate(2, { ttlMs: 5, reason: 'r' })
    await e1.release()
    await expect(e1.release()).resolves.toBeUndefined() // double-release safe

    // After expiry: another release call must not throw.
    const e2 = await vault.elevate(2, { ttlMs: 5, reason: 'r2' })
    await new Promise((r) => setTimeout(r, 25))
    await expect(e2.release()).resolves.toBeUndefined()
  })

  it('7. TierNotGrantedError when keyring cannot reach the tier (non-owner/admin)', async () => {
    // Set up an operator with no tier-2 DEK on any collection.
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const vault = await db.openVault('v1')
    vault.collection<Doc>('docs', { tiers: [0, 1, 2] })

    await db.grant('v1', {
      userId: 'op',
      displayName: 'Op',
      role: 'operator',
      passphrase: 'op-pw',
      permissions: { docs: 'rw' },
    })
    await db.close()

    const opDb = await createNoydb({ store, secret: 'op-pw', user: 'op' })
    const opVault = await opDb.openVault('v1')

    await expect(
      opVault.elevate(2, { ttlMs: 60_000, reason: 'no-key' }),
    ).rejects.toBeInstanceOf(TierNotGrantedError)
  })

  it('8. validates the `reason` and `tier` arguments', async () => {
    const { vault } = await ownerVault()
    vault.collection<Doc>('docs', { tiers: [0, 1, 2] })

    await expect(
      vault.elevate(0, { ttlMs: 60_000, reason: 'r' }),
    ).rejects.toThrow(/positive integer/)
    await expect(
      vault.elevate(2, { ttlMs: 60_000, reason: '' }),
    ).rejects.toThrow(/reason/)
    await expect(
      vault.elevate(2, { ttlMs: 0, reason: 'r' }),
    ).rejects.toThrow(/ttlMs/)
  })

  it('9. TTL auto-frees the active-elevation slot — next elevate() succeeds without manual release', async () => {
    const { vault } = await ownerVault()
    vault.collection<Doc>('docs', { tiers: [0, 1, 2] })

    const e1 = await vault.elevate(2, { ttlMs: 5, reason: 'a' })
    await new Promise((r) => setTimeout(r, 25))
    // Trigger the lazy-expiry path. It throws but also frees the slot.
    await expect(
      e1.collection<Doc>('docs').put('d1', { id: 'd1', title: 'T', body: 'B' }),
    ).rejects.toBeInstanceOf(ElevationExpiredError)

    const e2 = await vault.elevate(2, { ttlMs: 60_000, reason: 'b' })
    expect(e2.tier).toBe(2)
    await e2.release()
  })
})
