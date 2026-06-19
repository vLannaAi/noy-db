// packages/hub/__tests__/bundle-magic-export.test.ts
import { describe, it, expect } from 'vitest'
import { hasNoydbBundleMagic } from '../src/index.js'
import { writeNoydbBundle } from '../src/bundle/bundle.js'
import { createNoydb } from '../src/noydb.js'
import { ConflictError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'

function memStore(): NoydbStore {
  const s = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string) => {
    let comp = s.get(c); if (!comp) { comp = new Map(); s.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return s.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { s.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const m = s.get(c)?.get(col); return m ? [...m.keys()] : [] },
    async loadAll(c) {
      const comp = s.get(c); const out: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; out[n] = r }
      return out
    },
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) } },
  }
}

describe('hasNoydbBundleMagic public export', () => {
  it('is exported from @noy-db/hub and detects a real single-vault bundle', async () => {
    expect(typeof hasNoydbBundleMagic).toBe('function')
    const db = await createNoydb({ store: memStore(), user: 'a', secret: 'correct-horse-battery-staple' })
    const vault = await db.openVault('test-vault')
    const bundle = await writeNoydbBundle(vault, {})
    expect(hasNoydbBundleMagic(bundle)).toBe(true)
    expect(hasNoydbBundleMagic(new Uint8Array([0, 1, 2, 3]))).toBe(false)
  })
})
