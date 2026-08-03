/**
 * Task 3 (#943 pod signature): `Vault._loadPodSigner()` gives `writePod` a
 * read-only `DocSigner | null` for the vault WITHOUT minting and WITHOUT
 * requiring the `withAttestation()` opt-in. Covers:
 *   - no signer minted yet → null (no mint, no throw)
 *   - a signer already persisted (minted via the same store+getDEK path
 *     `loadOrCreateSigner` uses — the least-invasive real path, since
 *     `getDocumentSigningPublicKey()` requires `withAttestation()`, which
 *     this seam deliberately does not) → the same `DocSigner` comes back.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { loadOrCreateSigner, type DocSigner } from '../src/with-audit/attestation/signer.js'

/** Inline memory adapter — same shape as other kernel/integration tests. */
function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(v: string, c: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(v)
    if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(c)
    if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getCollection(v, c)
      const existing = coll.get(id)
      if (ev !== undefined && existing && existing._v !== ev) throw new ConflictError(existing._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { const coll = store.get(v)?.get(c); return coll ? [...coll.keys()] : [] },
    async loadAll(v) {
      const comp = store.get(v)
      const snapshot: VaultSnapshot = {}
      if (comp) for (const [name, coll] of comp) { if (!name.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; snapshot[name] = r } }
      return snapshot
    },
    async saveAll(v, data) {
      for (const [name, records] of Object.entries(data)) { const coll = getCollection(v, name); for (const [id, e] of Object.entries(records)) coll.set(id, e) }
    },
  }
}

/** Typed cast helper for the `_`-prefixed kernel-internal seam under test. */
interface PodSignerAccess {
  _loadPodSigner(): Promise<DocSigner | null>
}

describe('Vault._loadPodSigner (#943 Task 3)', () => {
  it('returns null before any signer has been minted — no mint, no throw', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'owner', secret: 'pod-signer-test-secret' })
    const vault = await db.openVault('V1')

    const result = await (vault as unknown as PodSignerAccess)._loadPodSigner()

    expect(result).toBeNull()
    db.close()
  })

  it('returns the persisted DocSigner once one exists, without withAttestation()', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'pod-signer-test-secret' })
    const vault = await db.openVault('V1')

    // Mint directly against the same store + the vault's own getDEK — the
    // least-invasive real path. `getDocumentSigningPublicKey()` is not used
    // here because it requires the `withAttestation()` opt-in, which this
    // seam is explicitly exempt from.
    const getDEK = (vault as unknown as { getDEK(collection: string): Promise<CryptoKey> }).getDEK
    const minted = await loadOrCreateSigner(store, 'V1', getDEK)

    const result = await (vault as unknown as PodSignerAccess)._loadPodSigner()

    expect(result).not.toBeNull()
    expect(result!.keyId).toMatch(/^[0-9a-f]{16}$/)
    expect(result!.keyId).toBe(minted.keyId)
    expect(result!.publicKeyB64).toBeTruthy()
    expect(result!.publicKeyB64).toBe(minted.publicKeyB64)
    db.close()
  })
})
