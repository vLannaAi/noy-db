/**
 * Task 2 (#944 pod-redirect): `followRedirects` — the resolver that walks a
 * chain of Redirect records starting from a pod's bytes, verifying each hop,
 * detecting loops, capping depth, and surfacing typed failures + ordered hop
 * provenance.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { writePod, readPodHeader } from '../src/index.js'
import {
  signRedirect,
  followRedirects,
  type Redirect,
} from '../src/with-pod/redirect.js'
import { readPodRedirect } from '../src/with-pod/bundle.js'
import { encodeBundleHeader, readUint32BE, writeUint32BE, NOYDB_BUNDLE_PREFIX_BYTES, type NoydbPodHeader } from '../src/with-pod/format.js'
import { generateDocSigningKeyPair } from '@noy-db/attestation'
import type { DocSigner } from '../src/with-audit/attestation/signer.js'
import {
  RedirectBadSignatureError,
  RedirectDepthExceededError,
  RedirectLoopError,
  RedirectUnreachableError,
  ConflictError,
} from '../src/kernel/errors.js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  ListPageResult,
} from '../src/kernel/types.js'

/** Inline memory adapter — same shape as pod-redirect-record.test.ts. */
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

/** A fresh vault with one record, as raw pod bytes; `redirect` is optional. */
async function pod(redirect?: Redirect): Promise<Uint8Array> {
  const store = toMemory()
  const db = await createNoydb({ store, user: 'owner', secret: 'redirect-follow-secret', historyStrategy: withHistory() })
  const vault = await db.openVault('V1')
  await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })
  const bytes = await writePod(vault, redirect !== undefined ? { redirect } : {})
  db.close()
  return bytes
}

/**
 * Flip the redirect record's `target` string inside the header, after
 * signing, so the record's signature no longer matches its contents.
 * Mirrors `reassembleWithHeader` in pod-signature-verify.test.ts.
 */
function tamperRedirectTarget(bytes: Uint8Array): Uint8Array {
  const header = readPodHeader(bytes)
  const redirect = header.redirect
  if (!redirect) throw new Error('test setup: header has no redirect field')
  const mutated: NoydbPodHeader = { ...header, redirect: { ...redirect, target: `${redirect.target}-tampered` } }

  const headerLen = readUint32BE(bytes, 6)
  const bodyOffset = NOYDB_BUNDLE_PREFIX_BYTES + headerLen
  const body = bytes.slice(bodyOffset)
  const newHeaderBytes = encodeBundleHeader(mutated)
  const out = new Uint8Array(NOYDB_BUNDLE_PREFIX_BYTES + newHeaderBytes.length + body.length)
  out.set(bytes.slice(0, NOYDB_BUNDLE_PREFIX_BYTES), 0)
  writeUint32BE(out, 6, newHeaderBytes.length)
  out.set(newHeaderBytes, NOYDB_BUNDLE_PREFIX_BYTES)
  out.set(body, NOYDB_BUNDLE_PREFIX_BYTES + newHeaderBytes.length)
  return out
}

describe('followRedirects (#944 Task 2)', () => {
  it('a start pod with no redirect is already terminal: {terminal: start, hops: []}', async () => {
    const start = await pod()

    const result = await followRedirects(start, async () => null, { trustedKeys: {} })

    expect(result.terminal).toBe(start)
    expect(result.hops).toEqual([])
  })

  it('chain-of-2 (start→A→terminal): returns terminal bytes + 2 hops in order', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const trustedKeys = { [signer.keyId]: signer.publicKeyB64 }

    const terminal = await pod()
    const redirectToTerminal = await signRedirect(signer, { target: 'pod:terminal', reason: 'moved' })
    const podA = await pod(redirectToTerminal)
    const redirectToA = await signRedirect(signer, { target: 'pod:A', reason: 'release' })
    const start = await pod(redirectToA)

    const fetcher = async (target: string): Promise<Uint8Array | null> => {
      if (target === 'pod:A') return podA
      if (target === 'pod:terminal') return terminal
      return null
    }

    const result = await followRedirects(start, fetcher, { trustedKeys })

    expect(result.terminal).toBe(terminal)
    expect(readPodRedirect(result.terminal)).toBeUndefined()
    expect(result.hops).toEqual([
      { target: 'pod:A', reason: 'release', issuedBy: signer.keyId },
      { target: 'pod:terminal', reason: 'moved', issuedBy: signer.keyId },
    ])
  })

  it('a loop (start→A→start) throws RedirectLoopError', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const trustedKeys = { [signer.keyId]: signer.publicKeyB64 }

    const redirectToStart = await signRedirect(signer, { target: 'pod:start', reason: 'repoint' })
    const podA = await pod(redirectToStart)
    const redirectToA = await signRedirect(signer, { target: 'pod:A', reason: 'repoint' })
    const start = await pod(redirectToA)

    const fetcher = async (target: string): Promise<Uint8Array | null> => {
      if (target === 'pod:A') return podA
      if (target === 'pod:start') return start
      return null
    }

    await expect(followRedirects(start, fetcher, { trustedKeys })).rejects.toThrow(RedirectLoopError)
  })

  it('over-depth: a 4-hop chain with maxDepth:2 throws RedirectDepthExceededError', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const trustedKeys = { [signer.keyId]: signer.publicKeyB64 }

    const terminal = await pod()
    const redirectToTerminal = await signRedirect(signer, { target: 'pod:D', reason: 'moved' })
    const podD = await pod(redirectToTerminal)
    const redirectToD = await signRedirect(signer, { target: 'pod:C', reason: 'moved' })
    const podC = await pod(redirectToD)
    const redirectToC = await signRedirect(signer, { target: 'pod:B', reason: 'moved' })
    const podB = await pod(redirectToC)
    const redirectToB = await signRedirect(signer, { target: 'pod:A', reason: 'moved' })
    const start = await pod(redirectToB)

    const fetcher = async (target: string): Promise<Uint8Array | null> => {
      if (target === 'pod:A') return podB
      if (target === 'pod:B') return podC
      if (target === 'pod:C') return podD
      if (target === 'pod:D') return terminal
      return null
    }

    await expect(followRedirects(start, fetcher, { trustedKeys, maxDepth: 2 })).rejects.toThrow(
      RedirectDepthExceededError,
    )
  })

  it('a tampered hop (target flipped after signing) throws RedirectBadSignatureError', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const trustedKeys = { [signer.keyId]: signer.publicKeyB64 }

    const redirect = await signRedirect(signer, { target: 'pod:A', reason: 'moved' })
    const start = tamperRedirectTarget(await pod(redirect))

    await expect(followRedirects(start, async () => null, { trustedKeys })).rejects.toThrow(
      RedirectBadSignatureError,
    )
  })

  it('an untrusted issuedBy (signer not in trustedKeys) throws RedirectBadSignatureError', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const redirect = await signRedirect(signer, { target: 'pod:A', reason: 'moved' })
    const start = await pod(redirect)

    await expect(followRedirects(start, async () => null, { trustedKeys: {} })).rejects.toThrow(
      RedirectBadSignatureError,
    )
  })

  it('fetcher returning null for the target throws RedirectUnreachableError', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const trustedKeys = { [signer.keyId]: signer.publicKeyB64 }
    const redirect = await signRedirect(signer, { target: 'pod:missing', reason: 'moved' })
    const start = await pod(redirect)

    await expect(followRedirects(start, async () => null, { trustedKeys })).rejects.toThrow(
      RedirectUnreachableError,
    )
  })

  it('fetcher throwing for the target throws RedirectUnreachableError', async () => {
    const signer = (await generateDocSigningKeyPair()) as DocSigner
    const trustedKeys = { [signer.keyId]: signer.publicKeyB64 }
    const redirect = await signRedirect(signer, { target: 'pod:broken', reason: 'moved' })
    const start = await pod(redirect)

    const fetcher = async (): Promise<Uint8Array | null> => { throw new Error('network down') }

    await expect(followRedirects(start, fetcher, { trustedKeys })).rejects.toThrow(RedirectUnreachableError)
  })
})
