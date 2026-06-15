/**
 * #413 — debug-plaintext store mode. When `encrypt: false` + `debugPlaintext:
 * true`, user-collection records are written with their fields inlined beside
 * the envelope metadata (`_debug: 1`, empty `_data`) so native store tooling
 * reads them directly. Encryption + debug is rejected at construction.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, DebugPlaintextError, DebugReservedFieldError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'

function makeStore(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function bucket(v: string, c: string) {
    let m = store.get(v); if (!m) { m = new Map(); store.set(v, m) }
    let b = m.get(c); if (!b) { b = new Map(); m.set(c, b) }
    return b
  }
  return {
    name: 'memory',
    async get(v, c, id) { return bucket(v, c).get(id) ?? null },
    async put(v, c, id, env, ev) { const b = bucket(v, c); const ex = b.get(id); if (ev !== undefined && (ex?._v ?? 0) !== ev) throw new ConflictError(ex?._v ?? 0); b.set(id, env) },
    async delete(v, c, id) { bucket(v, c).delete(id) },
    async list(v, c) { return [...bucket(v, c).keys()] },
    async loadAll(v) { const m = store.get(v); const s: VaultSnapshot = {}; if (m) for (const [n, c] of m) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of c) r[id] = e; s[n] = r } return s },
    async saveAll(v, data) { for (const [n, recs] of Object.entries(data)) { const b = bucket(v, n); for (const [id, e] of Object.entries(recs)) b.set(id, e) } },
  }
}

describe('#413 — debug-plaintext store mode', () => {
  it('rejects debugPlaintext combined with encryption (explicit)', async () => {
    await expect(
      createNoydb({ store: makeStore(), user: 'op', secret: 'passphrase-1234-long-enough', encrypt: true, debugPlaintext: true }),
    ).rejects.toBeInstanceOf(DebugPlaintextError)
  })

  it('rejects debugPlaintext with default (encryption on)', async () => {
    await expect(
      createNoydb({ store: makeStore(), user: 'op', secret: 'passphrase-1234-long-enough', debugPlaintext: true }),
    ).rejects.toBeInstanceOf(DebugPlaintextError)
  })

  it('inlines record fields into a directly-inspectable envelope', async () => {
    const store = makeStore()
    const db = await createNoydb({ store, user: 'op', encrypt: false, debugPlaintext: true })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string; name: string; n: number }>('docs')
    await docs.put('d1', { id: 'd1', name: 'Alice', n: 7 })

    // The raw stored envelope is directly readable — no _data unwrap needed.
    const raw = (await store.get('t', 'docs', 'd1'))! as EncryptedEnvelope & Record<string, unknown>
    expect(raw._debug).toBe(1)
    expect(raw._data).toBe('')
    expect(raw.name).toBe('Alice')
    expect(raw.n).toBe(7)
    expect(raw.id).toBe('d1')

    // get() reconstructs the record from the inlined fields.
    expect(await docs.get('d1')).toEqual({ id: 'd1', name: 'Alice', n: 7 })
  })

  it('round-trips updates in debug layout', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', encrypt: false, debugPlaintext: true })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string; v: number }>('docs')
    await docs.put('d1', { id: 'd1', v: 1 })
    await docs.put('d1', { id: 'd1', v: 2 })
    expect(await docs.get('d1')).toEqual({ id: 'd1', v: 2 })
  })

  it('rejects a record with a reserved _-prefixed field', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', encrypt: false, debugPlaintext: true })
    const vault = await db.openVault('t')
    const docs = vault.collection<Record<string, unknown>>('docs')
    await expect(docs.put('d1', { id: 'd1', _secret: 1 })).rejects.toBeInstanceOf(DebugReservedFieldError)
  })

  it('classic plaintext mode (no debugPlaintext) is unchanged — _data carries the JSON', async () => {
    const store = makeStore()
    const db = await createNoydb({ store, user: 'op', encrypt: false })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string; name: string }>('docs')
    await docs.put('d1', { id: 'd1', name: 'Bob' })
    const raw = (await store.get('t', 'docs', 'd1'))! as EncryptedEnvelope & Record<string, unknown>
    expect(raw._debug).toBeUndefined()
    expect(JSON.parse(raw._data)).toEqual({ id: 'd1', name: 'Bob' })
    expect(await docs.get('d1')).toEqual({ id: 'd1', name: 'Bob' })
  })

  it('a debug-written envelope is self-describing — a classic plaintext reader reconstructs it', async () => {
    const store = makeStore()
    const dbg = await createNoydb({ store, user: 'op', encrypt: false, debugPlaintext: true })
    const v1 = await dbg.openVault('t')
    await v1.collection<{ id: string; name: string }>('docs').put('d1', { id: 'd1', name: 'Carol' })

    // Re-open the same store WITHOUT debug mode; the _debug marker drives reconstruction.
    const plain = await createNoydb({ store, user: 'op', encrypt: false })
    const v2 = await plain.openVault('t')
    expect(await v2.collection<{ id: string; name: string }>('docs').get('d1')).toEqual({ id: 'd1', name: 'Carol' })
  })
})
