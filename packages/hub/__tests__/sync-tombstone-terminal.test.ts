import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ErasureEnforcement } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-party/sync/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { isTombstoneShape } from '../src/kernel/enclave/record-keys/tombstone.js'

/** In-memory store (mirrors the harness in sync.test.ts). */
function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
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
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

/** A crypto-shred tombstone as `buildTombstone` mints it. */
function tombstoneEnv(v: number, ts = new Date().toISOString()): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: ts, _iv: '', _data: '' }
}

interface Note { body: string; subjectId?: string }
const V = 'V1'

describe('isTombstoneShape', () => {
  it('recognises the buildTombstone shape and nothing else', () => {
    expect(isTombstoneShape(tombstoneEnv(3))).toBe(true)
    // live encrypted envelope: non-empty _data
    expect(isTombstoneShape({ _noydb: 1, _v: 1, _ts: 'x', _iv: 'abc', _data: 'ciphertext' })).toBe(false)
    // unencrypted record envelope: non-empty JSON _data, empty _iv
    expect(isTombstoneShape({ _noydb: 1, _v: 1, _ts: 'x', _iv: '', _data: '{"a":1}' })).toBe(false)
    // _sync meta shape: empty _iv, non-empty _data
    expect(isTombstoneShape({ _noydb: 1, _v: 1, _ts: 'x', _iv: '', _data: '{"dirty":[]}' })).toBe(false)
    // empty _data but a wrapped CEK present → not a shred
    expect(isTombstoneShape({ _noydb: 1, _v: 1, _ts: 'x', _iv: '', _data: '', _cek: 'wrapped' })).toBe(false)
  })
})
