/**
 * #712 (at-rest hardening, Task 1) — the `rewrapHistory` primitive.
 *
 * Spec: docs/superpowers/specs/2026-07-16-history-at-rest-design.md
 * Plan: docs/superpowers/plans/2026-07-16-history-at-rest.md
 *
 * This is the primitive-level suite. It exercises `rewrapHistory` directly
 * against a bare in-memory adapter + hand-derived DEKs — no `createNoydb`,
 * no tier ops (those are Task 2's integration wiring into
 * elevate/demote/putAtTier, tested against the real record/tier machinery).
 */

import { describe, it, expect } from 'vitest'
import { NO_HISTORY } from '../src/with-commit/history/strategy.js'
import { rewrapHistory } from '../src/with-commit/history/history.js'
import { NOYDB_FORMAT_VERSION, type EncryptedEnvelope, type NoydbStore, type VaultSnapshot } from '../src/kernel/types.js'
import { generateDEK, wrapCek, unwrapCek, encrypt, decrypt, type EnclaveKey } from '../src/kernel/enclave/index.js'

const HISTORY_COLLECTION = '_history'
const VAULT = 'v'

/** Minimal in-memory NoydbStore — enough surface for rewrapHistory (get/put/list). */
function memory(): NoydbStore {
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
    const store = memory()
    const dekA = await generateDEK()
    const dekB = await generateDEK()
    await expect(NO_HISTORY.rewrapHistory(store, VAULT, 'docs', 'd1', dekA, dekB)).resolves.toBeUndefined()
    expect(await store.list(VAULT, HISTORY_COLLECTION)).toEqual([])
  })
})

describe('rewrapHistory — primitive', () => {
  it('rewraps a perRecordKeys history snapshot from fromDek to toDek, preserving content', async () => {
    const store = memory()
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
    const store = memory()
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
    const store = memory()
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
    const store = memory()
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
    const store = memory()
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
    const store = memory()
    const tier0Dek = await generateDEK()
    const tierNDek = await generateDEK()
    const toDek = await generateDEK()
    const id = historyId('docs', 'd1', 1)
    await store.put(VAULT, HISTORY_COLLECTION, id, await buildCekEnvelope('pre-fix-secret', tier0Dek, 1))

    // No tier0Dek supplied — the mismatched fromDek must propagate, not be swallowed.
    await expect(rewrapHistory(store, VAULT, 'docs', 'd1', tierNDek, toDek)).rejects.toThrow()
  })

  it('a rewrap that fails under BOTH fromDek and tier0Dek re-throws (real corruption, not a tier mismatch)', async () => {
    const store = memory()
    const wrongDek1 = await generateDEK()
    const wrongDek2 = await generateDEK()
    const actualDek = await generateDEK()
    const toDek = await generateDEK()
    const id = historyId('docs', 'd1', 1)
    await store.put(VAULT, HISTORY_COLLECTION, id, await buildCekEnvelope('secret', actualDek, 1))

    await expect(rewrapHistory(store, VAULT, 'docs', 'd1', wrongDek1, toDek, wrongDek2)).rejects.toThrow()
  })
})
