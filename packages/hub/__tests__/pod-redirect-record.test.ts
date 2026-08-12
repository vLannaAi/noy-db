/**
 * Task 1 (#944 pod-redirect): the Redirect record — `signRedirect` /
 * `verifyRedirect` (record-level sign/verify via #943's
 * `signRecord`/`verifyRecord`), the `redirect` header field's structural
 * validation in `format.ts`, and `readPodRedirect` (mirrors `readPodCover`:
 * sync, no secret, returns the record UNVERIFIED).
 *
 * Signature verification of the redirect record is a SEPARATE concern from
 * the #943 pod-header signature: a pod can be signed (header sig) while
 * ALSO carrying a redirect with its own independent sig, and the redirect
 * field participates in the header signature by construction (it's just
 * another header field), so a signed pod carrying a redirect must still
 * verifyPodHeader → 'verified'.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { writePod } from '../src/index.js'
import { readPodRedirect, verifyPodHeader } from '../src/with-pod/pod.js'
import { validatePodHeaderFields, NOYDB_POD_FORMAT_VERSION } from '../src/with-pod/format.js'
import { signRedirect, verifyRedirect, type Redirect } from '../src/with-pod/redirect.js'
import { generateDocSigningKeyPair } from '@noy-db/attestation'
import type { DocSigner } from '../src/with-audit/attestation/signer.js'
import { ConflictError } from '../src/kernel/errors.js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  ListPageResult,
} from '../src/kernel/types.js'

/** Inline memory adapter — same shape as pod-signature-verify.test.ts. */
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

describe('Redirect record — signRedirect/verifyRedirect (#944 Task 1)', () => {
  it('round-trips: signRedirect → verifyRedirect === true against the signer\'s own key', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const record = await signRedirect(signer, { target: 'https://example.com/next-pod', reason: 'moved' })

    const ok = await verifyRedirect(record, { [signer.keyId]: signer.publicKeyB64 })

    expect(ok).toBe(true)
    expect(record.v).toBe(1)
    expect(record.issuedBy).toBe(signer.keyId)
  })

  it('a tampered target fails verification', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const record = await signRedirect(signer, { target: 'https://example.com/next-pod', reason: 'moved' })
    const tampered: Redirect = { ...record, target: 'https://evil.example.com/steal' }

    const ok = await verifyRedirect(tampered, { [signer.keyId]: signer.publicKeyB64 })

    expect(ok).toBe(false)
  })

  it('fails closed when issuedBy is not in trustedKeys', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const record = await signRedirect(signer, { target: 'https://example.com/next-pod', reason: 'moved' })

    const ok = await verifyRedirect(record, {})

    expect(ok).toBe(false)
  })
})

describe('redirect header field — structural validation (#944 Task 1)', () => {
  const baseV1 = {
    formatVersion: NOYDB_POD_FORMAT_VERSION,
    handle: '01HYABCDEFGHJKMNPQRSTVWXYZ',
    bodyBytes: 1234,
    bodySha256: 'a'.repeat(64),
  }
  const goodRedirect = {
    v: 1 as const,
    target: 'https://example.com/next-pod',
    reason: 'moved' as const,
    issuedBy: '0123456789abcdef',
    sig: 'abc123_-XYZ',
  }

  it('accepts a well-formed redirect header field', () => {
    expect(() => validatePodHeaderFields({ ...baseV1, redirect: goodRedirect })).not.toThrow()
  })

  it('still validates a header with no redirect field', () => {
    expect(() => validatePodHeaderFields(baseV1)).not.toThrow()
  })

  it('rejects a bad reason', () => {
    expect(() =>
      validatePodHeaderFields({ ...baseV1, redirect: { ...goodRedirect, reason: 'bogus' } }),
    ).toThrow(/header\.redirect\.reason must be one of/)
  })

  it('rejects a missing sig', () => {
    const { sig: _sig, ...withoutSig } = goodRedirect
    expect(() =>
      validatePodHeaderFields({ ...baseV1, redirect: withoutSig }),
    ).toThrow(/header\.redirect\.sig must be a non-empty base64url string/)
  })

  it('rejects a non-string target', () => {
    expect(() =>
      validatePodHeaderFields({ ...baseV1, redirect: { ...goodRedirect, target: 42 } }),
    ).toThrow(/header\.redirect\.target must be a non-empty string/)
  })

  it('rejects a malformed issuedBy (not 16-hex)', () => {
    expect(() =>
      validatePodHeaderFields({ ...baseV1, redirect: { ...goodRedirect, issuedBy: 'not-hex' } }),
    ).toThrow(/header\.redirect\.issuedBy must be a 16-character lowercase hex fingerprint/)
  })
})

describe('writePod/readPodRedirect round-trip (#944 Task 1)', () => {
  async function vaultWithOneRecord() {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'redirect-secret', historyStrategy: withHistory() })
    const vault = await db.openVault('V1')
    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })
    return { db, vault }
  }

  it('writePod({redirect}) → readPodRedirect returns it verbatim', async () => {
    const { db, vault } = await vaultWithOneRecord()
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const redirect = await signRedirect(signer, { target: 'https://example.com/next-pod', reason: 'tombstone' })

    const bytes = await writePod(vault, { redirect })
    db.close()

    expect(readPodRedirect(bytes)).toEqual(redirect)
  })

  it('a pod written with no redirect → readPodRedirect returns undefined', async () => {
    const { db, vault } = await vaultWithOneRecord()
    const bytes = await writePod(vault)
    db.close()

    expect(readPodRedirect(bytes)).toBeUndefined()
  })

  it('a signed pod (header sig) carrying a redirect field still verifyPodHeader → verified', async () => {
    const { db, vault } = await vaultWithOneRecord()
    const headerSigner = (await generateDocSigningKeyPair()) as DocSigner
    const redirectSigner = (await generateDocSigningKeyPair()) as DocSigner
    const redirect = await signRedirect(redirectSigner, { target: 'https://example.com/next-pod', reason: 'repoint' })

    const bytes = await writePod(vault, { sign: headerSigner, redirect })
    db.close()

    const result = await verifyPodHeader(bytes, { [headerSigner.keyId]: headerSigner.publicKeyB64 })

    expect(result.status).toBe('verified')
    expect(readPodRedirect(bytes)).toEqual(redirect)
  })
})
