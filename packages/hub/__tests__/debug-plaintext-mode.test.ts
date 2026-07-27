/**
 * #413 — debug-plaintext store mode. When `encrypt: false` + `debugPlaintext:
 * true`, user-collection records are written with their fields inlined beside
 * the envelope metadata (`_debug: 1`, empty `_data`) so native store tooling
 * reads them directly. Encryption + debug is rejected at construction.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, DebugPlaintextError, DebugReservedFieldError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withBlobs } from '../src/via/blob/index.js'
import { readPlaintextRecord } from '../src/kernel/debug.js'

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
      createNoydb({ store: makeStore(), user: 'op', secret: 'secret-1234-long-enough', encrypt: true, debugPlaintext: true }),
    ).rejects.toBeInstanceOf(DebugPlaintextError)
  })

  it('rejects debugPlaintext with default (encryption on)', async () => {
    await expect(
      createNoydb({ store: makeStore(), user: 'op', secret: 'secret-1234-long-enough', debugPlaintext: true }),
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

function payload(n: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7) & 0xff
  return b
}

describe('#413 P3 — readPlaintextRecord helper', () => {
  it('unwraps a debug-inlined envelope', () => {
    const env = { _noydb: 1, _v: 1, _ts: 't', _iv: '', _data: '', _by: 'op', _debug: 1, id: 'd1', name: 'Alice' }
    expect(readPlaintextRecord(env as never)).toEqual({ id: 'd1', name: 'Alice' })
  })
  it('unwraps a classic plaintext envelope', () => {
    const env = { _noydb: 1, _v: 1, _ts: 't', _iv: '', _data: JSON.stringify({ id: 'd1', n: 2 }) }
    expect(readPlaintextRecord(env as never)).toEqual({ id: 'd1', n: 2 })
  })
  it('throws on an encrypted envelope (non-empty _iv)', () => {
    const env = { _noydb: 1, _v: 1, _ts: 't', _iv: 'abc', _data: 'ciphertext' }
    expect(() => readPlaintextRecord(env as never)).toThrow(/encrypted/)
  })
})

describe('#413 P2 — debug-plaintext blobs: single un-gzipped object', () => {
  it('stores a blob as one un-gzipped, directly-decodable object', async () => {
    const store = makeStore()
    const db = await createNoydb({ store, user: 'op', encrypt: false, debugPlaintext: true, blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { f: {} } })
    await docs.put('d1', { id: 'd1' })
    const data = payload(2000)
    await docs.blob('d1').put('f', data)

    // Exactly one chunk object, plaintext, base64 decodes straight to the bytes.
    const chunkKeys = await store.list('t', '_blob_chunks')
    expect(chunkKeys.length).toBe(1)
    const chunk = (await store.get('t', '_blob_chunks', chunkKeys[0]!))!
    expect(chunk._iv).toBe('')
    expect(Buffer.from(chunk._data, 'base64').equals(Buffer.from(data))).toBe(true)

    // Blob index records compression none + a single chunk.
    const idxKeys = await store.list('t', '_blob_index')
    const idx = JSON.parse((await store.get('t', '_blob_index', idxKeys[0]!))!._data) as { compression: string; chunkCount: number }
    expect(idx.compression).toBe('none')
    expect(idx.chunkCount).toBe(1)

    // Round-trips through the API.
    const got = await docs.blob('d1').get('f')
    expect(Buffer.from(got!).equals(Buffer.from(data))).toBe(true)
  })

  it('classic plaintext mode still gzips blobs (debug differs)', async () => {
    const store = makeStore()
    const db = await createNoydb({ store, user: 'op', encrypt: false, blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { f: {} } })
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('f', payload(2000))

    const idxKeys = await store.list('t', '_blob_index')
    const idx = JSON.parse((await store.get('t', '_blob_index', idxKeys[0]!))!._data) as { compression: string }
    expect(idx.compression).toBe('gzip')
  })
})
