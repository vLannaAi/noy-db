/**
 * #409 — blob().get() must resolve + round-trip for any size. The bug:
 * compressBytes/decompressBytes awaited write+close before reading `readable`,
 * deadlocking once the (decompressed) output exceeded the stream buffer (~16KB).
 * put succeeded (small compressed output) but get() hung ≥16KB on any store.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import { withBlobs } from '../src/blobs/index.js'

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

/** Reject (instead of hang) if a promise doesn't settle — so a regression fails. */
function withTimeout<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms))])
}

/** Deterministic, low-compressibility-ish payload so round-trip equality is meaningful. */
function payload(n: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff
  return b
}

describe('#409 — blob get() resolves + round-trips for any size', () => {
  for (const kb of [8, 16, 64, 256, 1024]) {
    it(`round-trips a ${kb} KB blob without hanging`, async () => {
      const db = await createNoydb({ store: makeStore(), user: 'op', secret: 'passphrase-1234-long-enough', blobStrategy: withBlobs() })
      const vault = await db.openVault('t')
      const docs = vault.collection<{ id: string }>('docs', { blobFields: { f: {} } })
      await docs.put('d1', { id: 'd1' })

      const data = payload(kb * 1024)
      await withTimeout(docs.blob('d1').put('f', data))
      const got = await withTimeout(docs.blob('d1').get('f'))

      expect(got).not.toBeNull()
      expect(got!.byteLength).toBe(data.byteLength)
      expect(Buffer.from(got!).equals(Buffer.from(data))).toBe(true)
    })
  }

  it('round-trips a highly-compressible (all-zero) 64 KB blob', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: 'passphrase-1234-long-enough', blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { f: {} } })
    await docs.put('d1', { id: 'd1' })
    const data = new Uint8Array(64 * 1024) // all zeros → tiny compressed → large decompressed output
    await withTimeout(docs.blob('d1').put('f', data))
    const got = await withTimeout(docs.blob('d1').get('f'))
    expect(got?.byteLength).toBe(data.byteLength)
  })
})
