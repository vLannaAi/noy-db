/**
 * Task 2 (#942 pod-header L2 fields): `writePod` accepts the five optional
 * header fields (`engineRange`/`unlockMethods`/`hasApp`/`species`/
 * `pointerMode`) added to `format.ts` in Task 1, and `readPodHeader` returns
 * them verbatim. Also proves the seam with #943 header signing — the new
 * fields ride inside the signed header bytes and don't break verification.
 *
 * Cases:
 *   - all 5 fields set → round-trip through readPodHeader.
 *   - none set → legacy-shaped header, round-trips via readPod.
 *   - THE SEAM TEST: a vault with a minted signer, writePod with a subset of
 *     the 5 fields → verifyPodHeader reports 'verified'.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { writePod, readPod, readPodHeader, verifyPodHeader } from '../src/index.js'
import { loadOrCreateSigner, type DocSigner } from '../src/with-audit/attestation/signer.js'
import { ConflictError } from '../src/kernel/errors.js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  ListPageResult,
} from '../src/kernel/types.js'

/** Inline memory adapter — same shape as pod-signature-write.test.ts. */
function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
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
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
    async listPage(c, col, cursor, limit = 100): Promise<ListPageResult> {
      const coll = store.get(c)?.get(col)
      if (!coll) return { items: [], nextCursor: null }
      const ids = [...coll.keys()].sort()
      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, ids.length)
      const items: ListPageResult['items'] = []
      for (let i = start; i < end; i++) {
        const id = ids[i]!
        const envelope = coll.get(id)
        if (envelope) items.push({ id, envelope })
      }
      return { items, nextCursor: end < ids.length ? String(end) : null }
    },
  }
}

interface Invoice { id: string; amount: number }

/** Cast helper for the `_`-prefixed kernel-internal signer seam. */
interface PodSignerAccess {
  getDEK(collection: string): Promise<CryptoKey>
  _loadPodSigner(): Promise<DocSigner | null>
}

describe('writePod header L2 fields (#942 Task 2)', () => {
  it('carries all 5 fields verbatim through readPodHeader', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'l2-secret', historyStrategy: withHistory() })
    const vault = await db.openVault('V1')
    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })

    const bytes = await writePod(vault, {
      engineRange: '>=0.5 <1',
      unlockMethods: ['password', 'webauthn'],
      hasApp: true,
      species: 'full',
      pointerMode: 'public',
    })
    const header = readPodHeader(bytes)

    expect(header.engineRange).toBe('>=0.5 <1')
    expect(header.unlockMethods).toEqual(['password', 'webauthn'])
    expect(header.hasApp).toBe(true)
    expect(header.species).toBe('full')
    expect(header.pointerMode).toBe('public')
    db.close()
  })

  it('carries none of the 5 fields when omitted (legacy-shaped header)', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'l2-secret', historyStrategy: withHistory() })
    const vault = await db.openVault('V1')
    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })

    const bytes = await writePod(vault)
    const header = readPodHeader(bytes)

    expect(header.engineRange).toBeUndefined()
    expect(header.unlockMethods).toBeUndefined()
    expect(header.hasApp).toBeUndefined()
    expect(header.species).toBeUndefined()
    expect(header.pointerMode).toBeUndefined()

    const result = await readPod(bytes)
    const parsed = JSON.parse(result.dumpJson) as { collections: Record<string, Record<string, unknown>> }
    expect(parsed.collections['invoices']).toBeDefined()
    db.close()
  })

  it('THE SEAM TEST: the new fields ride inside the signed header and verify', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'l2-sign-secret', historyStrategy: withHistory() })
    const vault = await db.openVault('V1')
    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })

    const getDEK = (vault as unknown as PodSignerAccess).getDEK
    const signer = await loadOrCreateSigner(store, 'V1', getDEK)

    const bytes = await writePod(vault, {
      species: 'connection',
      hasApp: false,
      unlockMethods: ['oidc'],
    })

    const header = readPodHeader(bytes)
    expect(header.species).toBe('connection')
    expect(header.hasApp).toBe(false)
    expect(header.unlockMethods).toEqual(['oidc'])
    expect(header.formatVersion).toBe(2)

    const result = await verifyPodHeader(bytes, { [signer.keyId]: signer.publicKeyB64 })
    expect(result.status).toBe('verified')
    db.close()
  })
})
