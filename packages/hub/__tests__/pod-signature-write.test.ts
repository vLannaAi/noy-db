/**
 * Task 4 (#943 pod signature): `writePod` signs the pod header by default
 * when the source vault has a persisted document signer. Wires together
 * Tasks 1-3 (signature.ts, format v2, Vault._loadPodSigner).
 *
 * Cases:
 *   - vault WITH a minted signer → writePod produces a formatVersion-2
 *     header carrying keyId (16-hex), a non-empty sig, sigAlg 'ed25519'.
 *   - `{ sign: false }` → stays formatVersion 1, no sig tuple.
 *   - vault with NO signer → formatVersion 1, no sig, and NO signer row
 *     is minted by the export (no mint-on-export).
 *   - `{ sign: explicitDocSigner }` → signed with the injected signer's keyId,
 *     even when the vault has no persisted signer.
 *   - Body-key investigation: the signer record does NOT travel in the
 *     encrypted body (dump excludes `_attestations`) — documented below.
 *   - Unsigned writePod still round-trips (bodySha256 integrity intact).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { writePod, readPod, readPodHeader } from '../src/index.js'
import {
  loadOrCreateSigner,
  ATTESTATIONS_COLLECTION,
  SIGNER_RECORD_ID,
  type DocSigner,
} from '../src/with-audit/attestation/signer.js'
import { generateDocSigningKeyPair } from '@noy-db/attestation'
import { ConflictError } from '../src/kernel/errors.js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  ListPageResult,
} from '../src/kernel/types.js'

/** Inline memory adapter — same shape as bundle.test.ts. */
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

describe('writePod header signing (#943 Task 4)', () => {
  it('signs the header by default when the vault has a persisted signer', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'pod-sign-secret', historyStrategy: withHistory() })
    const vault = await db.openVault('V1')
    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })

    const getDEK = (vault as unknown as PodSignerAccess).getDEK
    const minted = await loadOrCreateSigner(store, 'V1', getDEK)

    const bytes = await writePod(vault)
    const header = readPodHeader(bytes)

    expect(header.formatVersion).toBe(2)
    expect(header.keyId).toMatch(/^[0-9a-f]{16}$/)
    expect(header.keyId).toBe(minted.keyId)
    expect(header.sig).toBeTruthy()
    expect(header.sig!.length).toBeGreaterThan(0)
    expect(header.sigAlg).toBe('ed25519')
    db.close()
  })

  it('never signs when { sign: false } is passed, even with a persisted signer', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'pod-sign-secret', historyStrategy: withHistory() })
    const vault = await db.openVault('V1')
    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })

    const getDEK = (vault as unknown as PodSignerAccess).getDEK
    await loadOrCreateSigner(store, 'V1', getDEK)

    const bytes = await writePod(vault, { sign: false })
    const header = readPodHeader(bytes)

    expect(header.formatVersion).toBe(1)
    expect(header.sig).toBeUndefined()
    expect(header.keyId).toBeUndefined()
    expect(header.sigAlg).toBeUndefined()
    db.close()
  })

  it('leaves an unsigned v1 header when the vault has no signer, and does not mint on export', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'pod-sign-secret', historyStrategy: withHistory() })
    const vault = await db.openVault('V1')
    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })

    const bytes = await writePod(vault)
    const header = readPodHeader(bytes)

    expect(header.formatVersion).toBe(1)
    expect(header.sig).toBeUndefined()
    expect(header.keyId).toBeUndefined()
    expect(header.sigAlg).toBeUndefined()

    // No mint-on-export: the signer row must still be absent after writePod.
    const signerRow = await store.get('V1', ATTESTATIONS_COLLECTION, SIGNER_RECORD_ID)
    expect(signerRow).toBeNull()
    db.close()
  })

  it('signs with an explicitly injected DocSigner (advanced/test injection)', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'pod-sign-secret', historyStrategy: withHistory() })
    const vault = await db.openVault('V1')
    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })

    // No persisted signer — the injected one is authoritative.
    const injected = (await generateDocSigningKeyPair()) as DocSigner
    const bytes = await writePod(vault, { sign: injected })
    const header = readPodHeader(bytes)

    expect(header.formatVersion).toBe(2)
    expect(header.keyId).toBe(injected.keyId)
    expect(header.sig).toBeTruthy()
    expect(header.sigAlg).toBe('ed25519')

    // The vault itself still has no persisted signer — injection did not mint.
    const signerRow = await store.get('V1', ATTESTATIONS_COLLECTION, SIGNER_RECORD_ID)
    expect(signerRow).toBeNull()
    db.close()
  })

  it('does NOT carry the signer keypair in the encrypted body — header keyId is the only pin', async () => {
    // FINDING: `vault.dump()` (via with-pod/backup.ts::dumpVault) reads
    // collections through `loadAll` (which filters ALL `_`-prefixed
    // collections) plus an EXPLICIT allowlist of internal collections
    // (_keyring/_ledger/_ledger_deltas/_schemas/_sequence/_history/_blob_*).
    // `_attestations` is NOT in that allowlist, so the signer record
    // (which holds the PRIVATE key too) never travels in the body. This
    // is the correct default — we would not want the private key shipped —
    // but it also means the signing PUBLIC key is not distributed via the
    // body today. The header keyId (fingerprint) is the pin; body-side
    // public-key distribution needs a follow-up (ship a public-key-only
    // record, not the full signer). See task-4-report.md.
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'pod-sign-secret', historyStrategy: withHistory() })
    const vault = await db.openVault('V1')
    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })
    const getDEK = (vault as unknown as PodSignerAccess).getDEK
    await loadOrCreateSigner(store, 'V1', getDEK)

    const bytes = await writePod(vault)
    const { dumpJson } = await readPod(bytes)
    const parsed = JSON.parse(dumpJson) as {
      collections: Record<string, unknown>
      _internal?: Record<string, unknown>
    }
    expect(parsed.collections[ATTESTATIONS_COLLECTION]).toBeUndefined()
    expect(parsed._internal?.[ATTESTATIONS_COLLECTION]).toBeUndefined()

    // Restore into a fresh vault (same secret) — the signer does not
    // materialise, so a post-unlock recipient cannot read the public key
    // from the restored body.
    const store2 = toMemory()
    const db2 = await createNoydb({ store: store2, user: 'owner', secret: 'pod-sign-secret', historyStrategy: withHistory() })
    const vault2 = await db2.openVault('V1')
    await vault2.load(dumpJson)
    const restoredSigner = await (vault2 as unknown as PodSignerAccess)._loadPodSigner()
    expect(restoredSigner).toBeNull()
    db.close()
    db2.close()
  })

  it('an unsigned writePod still round-trips via readPod (bodySha256 intact)', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'pod-sign-secret', historyStrategy: withHistory() })
    const vault = await db.openVault('V1')
    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })

    const bytes = await writePod(vault, { sign: false })
    const result = await readPod(bytes)
    expect(result.header.formatVersion).toBe(1)
    const parsed = JSON.parse(result.dumpJson) as { collections: Record<string, Record<string, unknown>> }
    expect(parsed.collections['invoices']).toBeDefined()
    db.close()
  })
})
