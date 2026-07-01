/**
 * Migration safety-net for the `_meta/sealed-passphrase` wire format.
 *
 * v1 (pre.16+): { v: 1, _noydb_sealed: 1, pid, payload }
 * Legacy (pre.14 / pre.15): { _noydb_sealed: 1, providerId, sealed }
 *
 * The hub MUST accept either shape on read so existing managed-mode
 * vaults sealed under earlier `at-env` releases continue to open after
 * the envelope rename in pre.16. Writes always produce v1 going forward.
 *
 * If this file ever fails, existing pre.14/pre.15 vaults stop opening —
 * a breaking change to any user with an at-env-sealed vault on disk.
 * Treat any failure here as P0.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../src/kernel/types.js'
import { ConflictError } from '../src/errors.js'
import {
  loadSealedPassphrase,
  saveSealedPassphrase,
  parseSealedEnvelope,
  SEALED_PASSPHRASE_RECORD_ID,
} from '../src/with-party/team/managed-passphrase.js'

function inlineMemory(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = data.get(v); if (!comp) { comp = new Map(); data.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    async get(v, c, id) { return gc(v, c).get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { gc(v, c).delete(id) },
    async list(v, c) { return [...gc(v, c).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
  }
}

/** Write a legacy-shape envelope directly so we can verify read compat. */
async function writeLegacyEnvelope(
  store: NoydbStore,
  vault: string,
  providerId: string,
  sealedBase64: string,
): Promise<void> {
  const env: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify({
      _noydb_sealed: 1,
      providerId,
      sealed: sealedBase64,
    }),
  }
  await store.put(vault, '_meta', SEALED_PASSPHRASE_RECORD_ID, env)
}

describe('parseSealedEnvelope — accepts both wire formats', () => {
  it('parses v1 shape', () => {
    const parsed = parseSealedEnvelope({
      v: 1,
      _noydb_sealed: 1,
      pid: 'env:NOYDB_SEALING_KEY',
      payload: 'AAEC', // 3 bytes
    })
    expect(parsed).toBeDefined()
    expect(parsed?.providerId).toBe('env:NOYDB_SEALING_KEY')
    expect(Array.from(parsed?.sealed ?? [])).toEqual([0, 1, 2])
  })

  it('parses legacy shape (pre.14 / pre.15)', () => {
    const parsed = parseSealedEnvelope({
      _noydb_sealed: 1,
      providerId: 'env:NOYDB_SEALING_KEY',
      sealed: 'AAEC',
    })
    expect(parsed).toBeDefined()
    expect(parsed?.providerId).toBe('env:NOYDB_SEALING_KEY')
    expect(Array.from(parsed?.sealed ?? [])).toEqual([0, 1, 2])
  })

  it('returns undefined for objects missing the _noydb_sealed marker', () => {
    expect(parseSealedEnvelope({ pid: 'x', payload: 'AA' })).toBeUndefined()
    expect(parseSealedEnvelope({ providerId: 'x', sealed: 'AA' })).toBeUndefined()
  })

  it('returns undefined for shapes that have the marker but lack required fields', () => {
    expect(parseSealedEnvelope({ _noydb_sealed: 1 })).toBeUndefined()
    expect(parseSealedEnvelope({ _noydb_sealed: 1, v: 1, pid: 'x' })).toBeUndefined() // missing payload
    expect(parseSealedEnvelope({ _noydb_sealed: 1, providerId: 'x' })).toBeUndefined() // missing sealed
  })

  it('returns undefined for non-objects', () => {
    expect(parseSealedEnvelope(null)).toBeUndefined()
    expect(parseSealedEnvelope(undefined)).toBeUndefined()
    expect(parseSealedEnvelope('string')).toBeUndefined()
    expect(parseSealedEnvelope(42)).toBeUndefined()
  })

  it('prefers v1 shape when both signal fields present (shouldn\'t happen, but is well-defined)', () => {
    const parsed = parseSealedEnvelope({
      v: 1,
      _noydb_sealed: 1,
      pid: 'v1-pid',
      payload: 'AAEC',
      providerId: 'legacy-pid',
      sealed: 'BAUG',
    })
    expect(parsed?.providerId).toBe('v1-pid')
    expect(Array.from(parsed?.sealed ?? [])).toEqual([0, 1, 2])
  })
})

describe('loadSealedPassphrase — reads existing pre.14/pre.15 envelopes', () => {
  it('loads a legacy-shape envelope written before the rename', async () => {
    const store = inlineMemory()
    // Simulate what pre.14/pre.15 wrote on disk.
    await writeLegacyEnvelope(store, 'acme', 'env:NOYDB_SEALING_KEY', 'AAEC')

    const loaded = await loadSealedPassphrase(store, 'acme')
    expect(loaded).toBeDefined()
    expect(loaded?.providerId).toBe('env:NOYDB_SEALING_KEY')
    expect(Array.from(loaded?.sealed ?? [])).toEqual([0, 1, 2])
  })

  it('loads a v1-shape envelope written by saveSealedPassphrase', async () => {
    const store = inlineMemory()
    await saveSealedPassphrase(store, 'acme', {
      providerId: 'env:NOYDB_SEALING_KEY',
      sealed: new Uint8Array([10, 20, 30]),
    })
    const loaded = await loadSealedPassphrase(store, 'acme')
    expect(loaded?.providerId).toBe('env:NOYDB_SEALING_KEY')
    expect(Array.from(loaded?.sealed ?? [])).toEqual([10, 20, 30])
  })
})

describe('saveSealedPassphrase — always produces v1 shape going forward', () => {
  it('writes the v1 wire format on first save', async () => {
    const store = inlineMemory()
    await saveSealedPassphrase(store, 'acme', {
      providerId: 'env:NOYDB_SEALING_KEY',
      sealed: new Uint8Array([0xDE, 0xAD]),
    })
    const onDisk = await store.get('acme', '_meta', SEALED_PASSPHRASE_RECORD_ID)
    expect(onDisk).toBeDefined()
    const parsed = JSON.parse(onDisk!._data) as Record<string, unknown>
    expect(parsed.v).toBe(1)
    expect(parsed._noydb_sealed).toBe(1)
    expect(parsed.pid).toBe('env:NOYDB_SEALING_KEY')
    expect(typeof parsed.payload).toBe('string')
    // No legacy fields in the new shape.
    expect(parsed.providerId).toBeUndefined()
    expect(parsed.sealed).toBeUndefined()
  })

  it('upgrades a legacy on-disk envelope to v1 on the next write', async () => {
    const store = inlineMemory()
    // Pre-populate with legacy shape.
    await writeLegacyEnvelope(store, 'acme', 'env:LEGACY', 'AAEC')

    // Now save through the modern API — should produce v1.
    await saveSealedPassphrase(store, 'acme', {
      providerId: 'env:NEW',
      sealed: new Uint8Array([42]),
    })
    const onDisk = await store.get('acme', '_meta', SEALED_PASSPHRASE_RECORD_ID)
    const parsed = JSON.parse(onDisk!._data) as Record<string, unknown>
    expect(parsed.v).toBe(1)
    expect(parsed.pid).toBe('env:NEW')
  })
})
