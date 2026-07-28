/**
 * #712 (at-rest hardening) — `rewrapHistory` primitive (Task 1) + the
 * integration wiring into elevate/demote/putAtTier (Task 2).
 *
 * Spec: docs/superpowers/specs/2026-07-16-history-at-rest-design.md
 * Plan: docs/superpowers/plans/2026-07-16-history-at-rest.md
 *
 * The first section is primitive-level: it exercises `rewrapHistory` directly
 * against a bare in-memory adapter + hand-derived DEKs — no `createNoydb`,
 * no tier ops. The `#712 at-rest` section below is the integration suite —
 * real `createNoydb`/`withTiers`/`withHistory` machinery, asserting the
 * at-rest property on the RAW `_history` envelope (the read-gate hides
 * `history()`/`getVersion()` for an elevated record, so only a raw-envelope
 * inspection pins that prior versions are no longer tier-0-decryptable).
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/index.js'
import { ConflictError } from '../src/kernel/errors.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { NO_HISTORY } from '../src/with-commit/history/strategy.js'
import { rewrapHistory } from '../src/with-commit/history/history.js'
import { NOYDB_FORMAT_VERSION, type EncryptedEnvelope, type NoydbStore, type VaultSnapshot } from '../src/kernel/types.js'
import { generateDEK, wrapCek, unwrapCek, encrypt, decrypt, rewrapBodyToDek, type EnclaveKey } from '../src/kernel/enclave/index.js'

const HISTORY_COLLECTION = '_history'
const VAULT = 'v'

/** Minimal in-memory NoydbStore — enough surface for rewrapHistory (get/put/list). */
function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env) { getCollection(c, col).set(id, env) },
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
      store.set(c, comp)
    },
  }
}

const historyId = (collection: string, recordId: string, version: number) =>
  `${collection}:${recordId}:${String(version).padStart(10, '0')}`

/** Build a perRecordKeys-style `_history` envelope: a fresh CEK wraps the
 * body under `wrapDek`, the body is encrypted under the CEK. */
async function buildCekEnvelope(plaintext: string, wrapDek: EnclaveKey, version = 1): Promise<EncryptedEnvelope> {
  const cek = await generateDEK()
  const { iv, data } = await encrypt(plaintext, cek)
  return {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: version,
    _ts: new Date().toISOString(),
    _iv: iv,
    _data: data,
    _cek: await wrapCek(cek, wrapDek),
  }
}

/** Build a legacy (no `_cek`) history envelope: body encrypted directly under `dek`. */
async function buildLegacyEnvelope(plaintext: string, dek: EnclaveKey, version = 1): Promise<EncryptedEnvelope> {
  const { iv, data } = await encrypt(plaintext, dek)
  return {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: version,
    _ts: new Date().toISOString(),
    _iv: iv,
    _data: data,
  }
}

describe('NO_HISTORY.rewrapHistory', () => {
  it('no-ops — does not throw, touches nothing', async () => {
    const store = toMemory()
    const dekA = await generateDEK()
    const dekB = await generateDEK()
    await expect(NO_HISTORY.rewrapHistory(store, VAULT, 'docs', 'd1', dekA, dekB)).resolves.toBeUndefined()
    expect(await store.list(VAULT, HISTORY_COLLECTION)).toEqual([])
  })
})

describe('rewrapHistory — primitive', () => {
  it('rewraps a perRecordKeys history snapshot from fromDek to toDek, preserving content', async () => {
    const store = toMemory()
    const fromDek = await generateDEK()
    const toDek = await generateDEK()
    const id = historyId('docs', 'd1', 1)
    const before = await buildCekEnvelope('v1-secret', fromDek, 1)
    await store.put(VAULT, HISTORY_COLLECTION, id, before)

    await rewrapHistory(store, VAULT, 'docs', 'd1', fromDek, toDek)

    const after = await store.get(VAULT, HISTORY_COLLECTION, id)
    expect(after).not.toBeNull()
    expect(after!._cek).toBeDefined()
    // No longer unwrappable under fromDek...
    await expect(unwrapCek(after!._cek!, fromDek)).rejects.toThrow()
    // ...but is under toDek, and the content decrypts unchanged.
    const cek = await unwrapCek(after!._cek!, toDek)
    const plaintext = await decrypt(after!._iv, after!._data, cek)
    expect(plaintext).toBe('v1-secret')
    // Version/timestamp/format metadata untouched by the rewrap.
    expect(after!._v).toBe(1)
    expect(after!._noydb).toBe(before._noydb)
  })

  it('rewraps a legacy (no _cek) history snapshot directly under the new DEK', async () => {
    const store = toMemory()
    const fromDek = await generateDEK()
    const toDek = await generateDEK()
    const id = historyId('legacy', 'd1', 1)
    await store.put(VAULT, HISTORY_COLLECTION, id, await buildLegacyEnvelope('legacy-body', fromDek, 1))

    await rewrapHistory(store, VAULT, 'legacy', 'd1', fromDek, toDek)

    const after = await store.get(VAULT, HISTORY_COLLECTION, id)
    expect(after!._cek).toBeUndefined()
    await expect(decrypt(after!._iv, after!._data, fromDek)).rejects.toThrow()
    expect(await decrypt(after!._iv, after!._data, toDek)).toBe('legacy-body')
  })

  it('rewraps every matching version for the record, leaves other records untouched', async () => {
    const store = toMemory()
    const fromDek = await generateDEK()
    const toDek = await generateDEK()
    const idV1 = historyId('docs', 'd1', 1)
    const idV2 = historyId('docs', 'd1', 2)
    const otherId = historyId('docs', 'd2', 1)
    await store.put(VAULT, HISTORY_COLLECTION, idV1, await buildCekEnvelope('v1', fromDek, 1))
    await store.put(VAULT, HISTORY_COLLECTION, idV2, await buildCekEnvelope('v2', fromDek, 2))
    await store.put(VAULT, HISTORY_COLLECTION, otherId, await buildCekEnvelope('other', fromDek, 1))

    await rewrapHistory(store, VAULT, 'docs', 'd1', fromDek, toDek)

    for (const id of [idV1, idV2]) {
      const env = await store.get(VAULT, HISTORY_COLLECTION, id)
      const cek = await unwrapCek(env!._cek!, toDek)
      expect(await decrypt(env!._iv, env!._data, cek)).toMatch(/^v[12]$/)
    }
    // d2's entry is untouched — still wrapped under fromDek only.
    const untouched = await store.get(VAULT, HISTORY_COLLECTION, otherId)
    expect(await unwrapCek(untouched!._cek!, fromDek)).toBeDefined()
    await expect(unwrapCek(untouched!._cek!, toDek)).rejects.toThrow()
  })

  it('skips tombstone-shaped entries (blanked _data, no _cek) — nothing to rewrap', async () => {
    const store = toMemory()
    const fromDek = await generateDEK()
    const toDek = await generateDEK()
    const id = historyId('docs', 'd1', 1)
    const tombstone: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: 1,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: '',
    }
    await store.put(VAULT, HISTORY_COLLECTION, id, tombstone)

    await expect(rewrapHistory(store, VAULT, 'docs', 'd1', fromDek, toDek)).resolves.toBeUndefined()

    const after = await store.get(VAULT, HISTORY_COLLECTION, id)
    expect(after).toEqual(tombstone)
  })

  it('legacy fallback: retries under tier0Dek when fromDek fails to unwrap, output always wrapped under toDek', async () => {
    const store = toMemory()
    const tier0Dek = await generateDEK()
    const tierNDek = await generateDEK() // the record's current tier — NOT what the snapshot is wrapped under
    const toDek = await generateDEK()
    const id = historyId('docs', 'd1', 1)
    // Pre-fix state: snapshot still wrapped under tier-0, even though the
    // record has since moved to tier N (the caller passes fromDek = tierNDek).
    await store.put(VAULT, HISTORY_COLLECTION, id, await buildCekEnvelope('pre-fix-secret', tier0Dek, 1))

    await rewrapHistory(store, VAULT, 'docs', 'd1', tierNDek, toDek, tier0Dek)

    const after = await store.get(VAULT, HISTORY_COLLECTION, id)
    const cek = await unwrapCek(after!._cek!, toDek)
    expect(await decrypt(after!._iv, after!._data, cek)).toBe('pre-fix-secret')
    await expect(unwrapCek(after!._cek!, tier0Dek)).rejects.toThrow()
    await expect(unwrapCek(after!._cek!, tierNDek)).rejects.toThrow()
  })

  it('without a tier0Dek fallback, a rewrap that fails under fromDek re-throws', async () => {
    const store = toMemory()
    const tier0Dek = await generateDEK()
    const tierNDek = await generateDEK()
    const toDek = await generateDEK()
    const id = historyId('docs', 'd1', 1)
    await store.put(VAULT, HISTORY_COLLECTION, id, await buildCekEnvelope('pre-fix-secret', tier0Dek, 1))

    // No tier0Dek supplied — the mismatched fromDek must propagate, not be swallowed.
    await expect(rewrapHistory(store, VAULT, 'docs', 'd1', tierNDek, toDek)).rejects.toThrow()
  })

  it('a rewrap that fails under BOTH fromDek and tier0Dek re-throws (real corruption, not a tier mismatch)', async () => {
    const store = toMemory()
    const wrongDek1 = await generateDEK()
    const wrongDek2 = await generateDEK()
    const actualDek = await generateDEK()
    const toDek = await generateDEK()
    const id = historyId('docs', 'd1', 1)
    await store.put(VAULT, HISTORY_COLLECTION, id, await buildCekEnvelope('secret', actualDek, 1))

    await expect(rewrapHistory(store, VAULT, 'docs', 'd1', wrongDek1, toDek, wrongDek2)).rejects.toThrow()
  })

  it('idempotent: calling rewrapHistory twice with the same from/to is a no-op the second time — entries stay unchanged (#712 whole-branch fix-3)', async () => {
    const store = toMemory()
    const fromDek = await generateDEK()
    const toDek = await generateDEK()
    const id = historyId('docs', 'd1', 1)
    await store.put(VAULT, HISTORY_COLLECTION, id, await buildCekEnvelope('v1-secret', fromDek, 1))

    await rewrapHistory(store, VAULT, 'docs', 'd1', fromDek, toDek)
    const afterFirst = await store.get(VAULT, HISTORY_COLLECTION, id)

    // Second call with the SAME (now stale) fromDek: without the toDek-first
    // idempotency skip, this would try to unwrap an already-toDek-wrapped
    // CEK under the stale fromDek and throw — the exact "retry re-fails
    // under both keys" wedge the fix closes for same-target retries.
    await rewrapHistory(store, VAULT, 'docs', 'd1', fromDek, toDek)
    const afterSecond = await store.get(VAULT, HISTORY_COLLECTION, id)

    expect(afterSecond).toEqual(afterFirst)
    const cek = await unwrapCek(afterSecond!._cek!, toDek)
    expect(await decrypt(afterSecond!._iv, afterSecond!._data, cek)).toBe('v1-secret')
  })

  it('skips entries already wrapped under toDek — a crash-recovery retry does not re-touch already-migrated entries (#712 whole-branch fix-3)', async () => {
    const store = toMemory()
    const fromDek = await generateDEK()
    const toDek = await generateDEK()
    const idV1 = historyId('docs', 'd1', 1)
    const idV2 = historyId('docs', 'd1', 2)
    // Simulate a crash mid-loop: v1 already migrated to toDek, v2 still
    // stranded under fromDek.
    const originalV1 = await buildCekEnvelope('v1-secret', toDek, 1)
    await store.put(VAULT, HISTORY_COLLECTION, idV1, originalV1)
    await store.put(VAULT, HISTORY_COLLECTION, idV2, await buildCekEnvelope('v2-secret', fromDek, 2))

    await rewrapHistory(store, VAULT, 'docs', 'd1', fromDek, toDek)

    // v1 was already at the target key — left byte-for-byte untouched (skipped,
    // not re-encrypted).
    const afterV1 = await store.get(VAULT, HISTORY_COLLECTION, idV1)
    expect(afterV1).toEqual(originalV1)
    // v2 was migrated by this call, same as the ordinary rewrap path.
    const afterV2 = await store.get(VAULT, HISTORY_COLLECTION, idV2)
    const cek2 = await unwrapCek(afterV2!._cek!, toDek)
    expect(await decrypt(afterV2!._iv, afterV2!._data, cek2)).toBe('v2-secret')
    await expect(unwrapCek(afterV2!._cek!, fromDek)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Task 2 — integration: syncHistory wired into elevate/demote/putAtTier.
// ---------------------------------------------------------------------------

interface HistDoc { id: string; body: string }

/** Full-fidelity NoydbStore (optimistic-concurrency `put`) for the real
 * `createNoydb` machinery — mirrors `hierarchical-tiers.test.ts`'s store. */
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

/** perRecordKeys + withHistory + withTiers ([0,1,2]) — the fixture the
 * plan's pseudocode calls `openHistoryTiers()`. */
async function openHistoryTiers() {
  const store = memoryStoreForTiers()
  const db = await createNoydb({
    store, user: 'owner', secret: 'pw-712-at-rest',
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

describe('#712 at-rest: history snapshots follow the record’s tier', () => {
  it('elevate rewraps history _cek to the tier-N DEK — no longer unwrappable under tier-0', async () => {
    const { store, docs, tier0Dek, tier1Dek } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1-secret' })
    await docs.put('d1', { id: 'd1', body: 'v2-secret' }) // v1 snapshot now in _history under tier-0
    const histId = 'docs:d1:0000000001'
    const before = await store.get('v1', '_history', histId)
    expect(before).not.toBeNull()
    // Pre-#712: `before._cek` unwraps under the tier-0 DEK → the leak.
    await expect(unwrapCek(before!._cek!, tier0Dek)).resolves.toBeDefined()

    await docs.elevate('d1', 1)

    const after = await store.get('v1', '_history', histId)
    expect(after).not.toBeNull()
    // AT-REST GUARANTEE: the snapshot's _cek no longer unwraps under tier-0…
    await expect(unwrapCek(after!._cek!, tier0Dek)).rejects.toThrow()
    // …and DOES under tier-1 (content preserved, moved not destroyed).
    const cek = await unwrapCek(after!._cek!, tier1Dek)
    expect(await decrypt(after!._iv, after!._data, cek)).toContain('v1-secret')
  })

  it('a cold tier-0-only session cannot decrypt an elevated record’s history at rest', async () => {
    const { vault, store, docs, tier0Dek } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1-secret' })
    await docs.put('d1', { id: 'd1', body: 'v2-secret' })
    await docs.elevate('d1', 1)

    // Strip the tier-1 DEK to simulate a tier-0-only session (same technique
    // `hierarchical-tiers.test.ts`'s invisibility tests use).
    const kr = (vault as unknown as { keyring: { deks: Map<string, EnclaveKey> } }).keyring
    kr.deks.delete('docs#1')

    // Read-gate (Arc 1, unchanged): history stays hidden through the API.
    expect(await docs.history('d1')).toEqual([])
    expect(await docs.getVersion('d1', 1)).toBeNull()

    // At-rest (this task): the raw history body is undecryptable under the
    // only DEK this session holds.
    const env = await store.get('v1', '_history', 'docs:d1:0000000001')
    expect(env).not.toBeNull()
    await expect(unwrapCek(env!._cek!, tier0Dek)).rejects.toThrow()
  })

  it('demote restores tier-0 readability of history', async () => {
    const { store, docs, tier0Dek } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' })
    await docs.elevate('d1', 1)
    await docs.demote('d1', 0)
    const env = await store.get('v1', '_history', 'docs:d1:0000000001')
    expect(env).not.toBeNull()
    const cek = await unwrapCek(env!._cek!, tier0Dek) // readable at tier-0 again
    expect(await decrypt(env!._iv, env!._data, cek)).toContain('v1')
  })

  it('putAtTier(>0) over a record with history rewraps that history too', async () => {
    const { store, docs, tier0Dek } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' })
    await docs.putAtTier('d1', { id: 'd1', body: 'v3' }, 1)
    const env = await store.get('v1', '_history', 'docs:d1:0000000001')
    expect(env).not.toBeNull()
    await expect(unwrapCek(env!._cek!, tier0Dek)).rejects.toThrow() // no longer tier-0-readable
  })

  it('the Arc-1 read-gate is unaffected: history()/getVersion() still return empty when elevated', async () => {
    const { docs } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' })
    await docs.elevate('d1', 1)
    expect(await docs.history('d1')).toEqual([])
    expect(await docs.getVersion('d1', 1)).toBeNull()
  })

  it('legacy fallback: a tier-0-wrapped history under a pre-fix elevated record demotes cleanly', async () => {
    const { store, docs, tier0Dek, tier1Dek } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' }) // creates the v1 _history snapshot, tier-0-wrapped

    // Simulate the PRE-FIX state: an elevate that moved only the live
    // envelope (via rewrapBodyToDek, same primitive elevate() itself uses)
    // and never touched history — exactly what elevate() did before #712.
    const live = await store.get('v1', 'docs', 'd1')
    expect(live).not.toBeNull()
    const body = await rewrapBodyToDek(live!, tier0Dek, tier1Dek)
    const preFixElevated: EncryptedEnvelope = {
      ...live!,
      _v: live!._v + 1,
      _iv: body._iv,
      _data: body._data,
      _tier: 1,
      ...(body._cek !== undefined ? { _cek: body._cek } : {}),
    }
    await store.put('v1', 'docs', 'd1', preFixElevated)

    // Confirm the pre-fix premise: history is STILL tier-0-wrapped.
    const histBefore = await store.get('v1', '_history', 'docs:d1:0000000001')
    expect(histBefore).not.toBeNull()
    await expect(unwrapCek(histBefore!._cek!, tier0Dek)).resolves.toBeDefined()

    await docs.demote('d1', 0)

    // demote()'s rewrap tried fromDek = tier-1 (the live record's tier),
    // failed against the still-tier-0-wrapped snapshot, and fell back to
    // tier0Dek — the legacy fallback in rewrapHistory. Now tier-0-readable.
    const histAfter = await store.get('v1', '_history', 'docs:d1:0000000001')
    expect(histAfter).not.toBeNull()
    const cek = await unwrapCek(histAfter!._cek!, tier0Dek)
    expect(await decrypt(histAfter!._iv, histAfter!._data, cek)).toContain('v1')
  })

  it('DEK-tracking holds across multi-step moves: elevate 0→1, elevate 1→2, demote 2→0', async () => {
    const { store, docs, tier0Dek, tier1Dek, tier2Dek } = await openHistoryTiers()
    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' })
    await docs.elevate('d1', 1)
    await docs.elevate('d1', 2)

    // Mid-flight discriminator: after two moves the snapshot must track to
    // tier-2 — NOT still sitting readable under tier-0 OR the intermediate
    // tier-1 DEK it passed through (a mid-chain gap would strand the
    // snapshot one step behind the live record's tier).
    const midEnv = await store.get('v1', '_history', 'docs:d1:0000000001')
    expect(midEnv).not.toBeNull()
    await expect(unwrapCek(midEnv!._cek!, tier0Dek)).rejects.toThrow()
    await expect(unwrapCek(midEnv!._cek!, tier1Dek)).rejects.toThrow()
    await expect(unwrapCek(midEnv!._cek!, tier2Dek)).resolves.toBeDefined()

    await docs.demote('d1', 0)

    // Public surface: the read-gate no longer applies (live record is back
    // at tier 0), so getVersion() should resolve the real prior version.
    expect(await docs.getVersion('d1', 1)).toMatchObject({ body: 'v1' })

    // At-rest: the raw snapshot's key material tracked every step and
    // landed back under tier-0.
    const env = await store.get('v1', '_history', 'docs:d1:0000000001')
    expect(env).not.toBeNull()
    const cek = await unwrapCek(env!._cek!, tier0Dek)
    expect(await decrypt(env!._iv, env!._data, cek)).toContain('v1')
  })
})
