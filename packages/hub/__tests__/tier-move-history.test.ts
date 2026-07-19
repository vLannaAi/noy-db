/**
 * #728 — tier moves (`elevate`/`demote`/`putAtTier`) snapshot the pre-move
 * version into `_history`. Before this fix, a tier move bumped `_v` and
 * overwrote the live envelope without ever saving the version that existed
 * just before the move — `history()` silently lost it.
 *
 * HARD correctness constraint (the crux): when the pre-move body is a
 * tier-0 body (elevate 0→N), its `_history` snapshot must be encrypted
 * under the DESTINATION tier's DEK, never the tier-0 DEK — otherwise a
 * tier-0 caller could read the elevated record's body via a raw `_history`
 * fetch, a new at-rest tier-invisibility leak. `ctx.codec.encryptRecord`
 * always resolves the tier-0 DEK, so the fix reuses the SAME
 * `rewrapBodyToDek(envelope, fromDek, toDek)` result each tier-move
 * function already computes for its live write.
 *
 * Plan: docs/superpowers/plans/2026-07-20-728-tier-move-history.md
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/index.js'
import { ConflictError } from '../src/kernel/errors.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { NOYDB_FORMAT_VERSION, type EncryptedEnvelope, type NoydbStore, type VaultSnapshot } from '../src/kernel/types.js'
import { unwrapCek, decrypt, type EnclaveKey } from '../src/kernel/enclave/index.js'

interface HistDoc { id: string; body: string }

/** Full-fidelity NoydbStore (optimistic-concurrency `put`) — mirrors
 * `history-at-rest.test.ts`'s `memoryStoreForTiers`. */
function memoryStoreForTiers(): NoydbStore {
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

const historyId = (collection: string, recordId: string, version: number) =>
  `${collection}:${recordId}:${String(version).padStart(10, '0')}`

/** perRecordKeys + withHistory + withTiers ([0,1,2]). */
async function openHistoryTiers() {
  const store = memoryStoreForTiers()
  const db = await createNoydb({
    store, user: 'owner', secret: 'pw-728-tier-move-history',
    tiersStrategy: withTiers(), historyStrategy: withHistory(),
  })
  const vault = await db.openVault('v1')
  const docs = vault.collection<HistDoc>('docs', { tiers: [0, 1, 2], perRecordKeys: true })
  const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
  const tier0Dek = await getDEK('docs')
  const tier1Dek = await getDEK('docs#1')
  const tier2Dek = await getDEK('docs#2')
  return { db, vault, docs, store, getDEK, tier0Dek, tier1Dek, tier2Dek }
}

/** No history strategy wired — tier moves should no-op the snapshot, never throw. */
async function openTiersNoHistory() {
  const store = memoryStoreForTiers()
  const db = await createNoydb({
    store, user: 'owner', secret: 'pw-728-no-history',
    tiersStrategy: withTiers(),
  })
  const vault = await db.openVault('v1')
  const docs = vault.collection<HistDoc>('docs', { tiers: [0, 1, 2] })
  return { store, docs }
}

describe('#728 tier moves snapshot the pre-move version into _history', () => {
  it('elevate(0→N) then demote(N→0): history() shows the pre-elevation entry with the original tier-0 body', async () => {
    const { docs } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1-secret' })
    await docs.elevate('d1', 1)
    await docs.demote('d1', 0)

    const history = await docs.history('d1')
    const preElevationEntry = history.find((h) => h.version === 1)
    expect(preElevationEntry).toBeDefined()
    expect(preElevationEntry!.record).toMatchObject({ body: 'v1-secret' })
  })

  it('INVISIBILITY: while elevated, the pre-elevation _history snapshot does not decrypt under tier-0 but does under tier-N', async () => {
    const { store, docs, tier0Dek, tier1Dek } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1-secret' })
    await docs.elevate('d1', 1)

    const env = await store.get('v1', '_history', historyId('docs', 'd1', 1))
    expect(env).not.toBeNull()
    expect(env!._tier).toBeUndefined() // untagged — matches an ordinary put() snapshot shape
    await expect(unwrapCek(env!._cek!, tier0Dek)).rejects.toThrow()
    const cek = await unwrapCek(env!._cek!, tier1Dek)
    expect(await decrypt(env!._iv, env!._data, cek)).toContain('v1-secret')

    // Public read-gate: history() stays hidden while elevated (existing #712 behavior).
    expect(await docs.history('d1')).toEqual([])
  })

  it('chained elevate(1→2): the snapshot is wrapped under tier 2, not tier 0 or tier 1', async () => {
    const { store, docs, tier0Dek, tier1Dek, tier2Dek } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.elevate('d1', 1) // v1 → _history:...0001 (tier-1 wrapped)
    await docs.elevate('d1', 2) // v2 (the tier-1 live body) → _history:...0002 (tier-2 wrapped)

    const secondSnapshot = await store.get('v1', '_history', historyId('docs', 'd1', 2))
    expect(secondSnapshot).not.toBeNull()
    await expect(unwrapCek(secondSnapshot!._cek!, tier0Dek)).rejects.toThrow()
    await expect(unwrapCek(secondSnapshot!._cek!, tier1Dek)).rejects.toThrow()
    const cek = await unwrapCek(secondSnapshot!._cek!, tier2Dek)
    expect(await decrypt(secondSnapshot!._iv, secondSnapshot!._data, cek)).toContain('v1')

    // The first elevate's snapshot follows the chain: the trailing syncHistory
    // rewrap of the second elevate() moves it tier-1 → tier-2 as well.
    const firstSnapshot = await store.get('v1', '_history', historyId('docs', 'd1', 1))
    await expect(unwrapCek(firstSnapshot!._cek!, tier1Dek)).rejects.toThrow()
    await expect(unwrapCek(firstSnapshot!._cek!, tier2Dek)).resolves.toBeDefined()
  })

  it('demote leaves the snapshot readable at rest under the tier-0 DEK once landed back at tier 0', async () => {
    const { store, docs, tier0Dek } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1-secret' })
    await docs.elevate('d1', 1)
    await docs.demote('d1', 0)

    const env = await store.get('v1', '_history', historyId('docs', 'd1', 1))
    expect(env).not.toBeNull()
    expect(env!._tier).toBeUndefined()
    const cek = await unwrapCek(env!._cek!, tier0Dek)
    expect(await decrypt(env!._iv, env!._data, cek)).toContain('v1-secret')
  })

  it('putAtTier over an existing record snapshots the prior version', async () => {
    const { store, docs, tier0Dek } = await openHistoryTiers()
    await docs.putAtTier('d1', { id: 'd1', body: 'v1' }, 0)
    await docs.putAtTier('d1', { id: 'd1', body: 'v2' }, 1)

    const env = await store.get('v1', '_history', historyId('docs', 'd1', 1))
    expect(env).not.toBeNull()
    expect(env!._tier).toBeUndefined()
    const history = await docs.history('d1')
    // Elevated now — read-gate hides it through the API; assert at rest instead.
    expect(history).toEqual([])
    await expect(unwrapCek(env!._cek!, tier0Dek)).rejects.toThrow()
  })

  it('first putAtTier (no existing record) snapshots nothing', async () => {
    const { store, docs } = await openHistoryTiers()
    await docs.putAtTier('d1', { id: 'd1', body: 'v1' }, 1)

    expect(await store.list('v1', '_history')).toEqual([])
  })

  it('history disabled (no withHistory): tier moves add no _history rows and do not throw', async () => {
    const { store, docs } = await openTiersNoHistory()
    await docs.put('d1', { id: 'd1', body: 'v1' })
    await expect(docs.elevate('d1', 1)).resolves.toBeDefined()
    await expect(docs.demote('d1', 0)).resolves.toBeDefined()
    await expect(docs.putAtTier('d1', { id: 'd1', body: 'v2' }, 1)).resolves.toBeDefined()

    expect(await store.list('v1', '_history')).toEqual([])
  })
})
