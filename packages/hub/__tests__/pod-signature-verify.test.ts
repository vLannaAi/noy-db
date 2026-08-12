/**
 * Task 5 (#943 pod signature): `verifyPodHeader(bytes, trustedKeys)` — a
 * pure, dependency-free, WebCrypto-only pod authenticator that pairs with
 * Task 4's `writePod` signing.
 *
 * The signed↔verify end-to-end proof (a signed pod + the signer's own public
 * key → `verified`) validates Tasks 4 and 5 together. The remaining cases pin
 * the four statuses and prove tamper detection covers the WHOLE signed
 * payload (not just the body):
 *   - signed + correct trustedKeys        → verified (keyId returned)
 *   - signed + empty trustedKeys          → untrusted (keyId returned)
 *   - unsigned v1 pod                     → unsigned (never 'verified')
 *   - signed, then a signed header field
 *     mutated with the old sig retained   → tampered  (bodySha256, keyId)
 *   - signed + right keyId → WRONG pubkey  → tampered
 *   - zero-dep: runs on only bytes + keys + globalThis.crypto (no Vault/store)
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { writePod, readPodHeader } from '../src/index.js'
import { verifyPodHeader } from '../src/with-pod/pod.js'
import {
  encodePodHeader,
  readUint32BE,
  writeUint32BE,
  NOYDB_POD_PREFIX_BYTES,
  type NoydbPodHeader,
} from '../src/with-pod/format.js'
import { generateDocSigningKeyPair } from '@noy-db/attestation'
import type { DocSigner } from '../src/with-audit/attestation/signer.js'
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

/** A vault with one record; returns the raw pod bytes signed by `signer`. */
async function signedPod(signer: DocSigner): Promise<Uint8Array> {
  const store = toMemory()
  const db = await createNoydb({ store, user: 'owner', secret: 'pod-verify-secret', historyStrategy: withHistory() })
  const vault = await db.openVault('V1')
  await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })
  const bytes = await writePod(vault, { sign: signer })
  db.close()
  return bytes
}

/** An unsigned v1 pod. */
async function unsignedPod(): Promise<Uint8Array> {
  const store = toMemory()
  const db = await createNoydb({ store, user: 'owner', secret: 'pod-verify-secret', historyStrategy: withHistory() })
  const vault = await db.openVault('V1')
  await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })
  const bytes = await writePod(vault, { sign: false })
  db.close()
  return bytes
}

/**
 * Re-wrap a pod with a fresh header, keeping the same body and prefix
 * flags/algo. Mirrors how the container is assembled (prefix → header → body)
 * so a tampered header round-trips through the real reader.
 */
function reassembleWithHeader(bytes: Uint8Array, newHeader: NoydbPodHeader): Uint8Array {
  const headerLen = readUint32BE(bytes, 6)
  const bodyOffset = NOYDB_POD_PREFIX_BYTES + headerLen
  const body = bytes.slice(bodyOffset)
  const newHeaderBytes = encodePodHeader(newHeader)
  const out = new Uint8Array(NOYDB_POD_PREFIX_BYTES + newHeaderBytes.length + body.length)
  out.set(bytes.slice(0, NOYDB_POD_PREFIX_BYTES), 0)
  writeUint32BE(out, 6, newHeaderBytes.length)
  out.set(newHeaderBytes, NOYDB_POD_PREFIX_BYTES)
  out.set(body, NOYDB_POD_PREFIX_BYTES + newHeaderBytes.length)
  return out
}

describe('verifyPodHeader (#943 Task 5)', () => {
  it('END-TO-END: a signed pod verifies against the signer\'s own public key', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const bytes = await signedPod(signer)
    const trustedKeys = { [signer.keyId]: signer.publicKeyB64 }

    const result = await verifyPodHeader(bytes, trustedKeys)

    expect(result.status).toBe('verified')
    expect(result.keyId).toBe(signer.keyId)
  })

  it('returns untrusted (with keyId) when the signing key is not in trustedKeys', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const bytes = await signedPod(signer)

    const result = await verifyPodHeader(bytes, {})

    expect(result.status).toBe('untrusted')
    expect(result.keyId).toBe(signer.keyId)
  })

  it('returns unsigned for a v1 pod with no signature, and never verified', async () => {
    const bytes = await unsignedPod()
    expect(readPodHeader(bytes).formatVersion).toBe(1)

    // Even with a populated trustedKeys map, an unsigned pod is unsigned.
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const result = await verifyPodHeader(bytes, { [signer.keyId]: signer.publicKeyB64 })

    expect(result.status).toBe('unsigned')
    expect(result.keyId).toBeUndefined()
    expect(result.status).not.toBe('verified')
  })

  it('detects tampering: mutating a signed field (bodySha256) while keeping the old sig → tampered', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const bytes = await signedPod(signer)
    const header = readPodHeader(bytes)

    // Flip bodySha256 to a different valid 64-hex string; keep the old sig.
    const mutated: NoydbPodHeader = { ...header, bodySha256: 'f'.repeat(64) }
    const tamperedBytes = reassembleWithHeader(bytes, mutated)

    const result = await verifyPodHeader(tamperedBytes, { [signer.keyId]: signer.publicKeyB64 })

    expect(result.status).toBe('tampered')
    expect(result.keyId).toBe(signer.keyId)
  })

  it('detects tampering across the WHOLE signed payload: mutating keyId (mapped to the correct key) → tampered', async () => {
    // The alg field can't be mutated (validation pins sigAlg to 'ed25519'),
    // so we prove keyId is inside the signed bytes instead: swap keyId to a
    // different 16-hex value, then map THAT keyId to the real public key so
    // the header is "trusted" and verification actually runs — over altered
    // canonical bytes → false → tampered.
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const bytes = await signedPod(signer)
    const header = readPodHeader(bytes)

    const forgedKeyId = '0123456789abcdef'
    expect(forgedKeyId).not.toBe(signer.keyId)
    const mutated: NoydbPodHeader = { ...header, keyId: forgedKeyId }
    const tamperedBytes = reassembleWithHeader(bytes, mutated)

    const result = await verifyPodHeader(tamperedBytes, { [forgedKeyId]: signer.publicKeyB64 })

    expect(result.status).toBe('tampered')
    expect(result.keyId).toBe(forgedKeyId)
  })

  it('returns tampered when the right keyId maps to the WRONG public key', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const wrong = (await generateDocSigningKeyPair()) as DocSigner
    const bytes = await signedPod(signer)

    // Correct keyId (so it's trusted and verification runs), but the public
    // key it maps to did not sign this pod.
    const result = await verifyPodHeader(bytes, { [signer.keyId]: wrong.publicKeyB64 })

    expect(result.status).toBe('tampered')
    expect(result.keyId).toBe(signer.keyId)
  })

  it('is zero-dependency: runs on only pod bytes + trustedKeys + globalThis.crypto (no Vault/store)', async () => {
    // By construction verifyPodHeader takes nothing but bytes + a key map —
    // no Vault, store, enclave, or DEK is threaded in. This asserts that
    // contract holds at the call site: the only ambient dependency is
    // WebCrypto, exactly what a static browser page has.
    expect(typeof globalThis.crypto?.subtle?.verify).toBe('function')

    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const bytes = await signedPod(signer)

    // Nothing from the vault is in scope here — only the bytes and the map.
    const result = await verifyPodHeader(bytes, { [signer.keyId]: signer.publicKeyB64 })
    expect(result.status).toBe('verified')
  })
})
