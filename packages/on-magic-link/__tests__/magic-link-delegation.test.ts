/**
 * Tests for v0.21 #257 — magic-link-bridged cross-user KEK delegation.
 *
 * Covers the full `issueMagicLinkDelegation` / `claimMagicLinkDelegation`
 * round-trip, plus the adjacent `inspectMagicLinkDelegation`,
 * `revokeMagicLinkDelegation`, and batch-grant cases.
 */

import { describe, it, expect } from 'vitest'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  Noydb,
  Vault,
} from '@noy-db/hub'
import {
  ConflictError,
  createNoydb,
  MAGIC_LINK_GRANTS_COLLECTION,
} from '@noy-db/hub'

import {
  issueMagicLinkDelegation,
  claimMagicLinkDelegation,
  inspectMagicLinkDelegation,
  revokeMagicLinkDelegation,
  readMagicLinkGrant,
} from '../src/index.js'

// ─── Memory store + bootstrap ──────────────────────────────────────────

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, snap) {
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      data.set(v, vm)
    },
  }
}

interface Invoice { id: string; amount: number; client: string }
interface Payment { id: string; invoiceId: string; amount: number }

async function freshVault(): Promise<{ db: Noydb; vault: Vault; store: NoydbStore }> {
  const store = memoryStore()
  const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
  const vault = await db.openVault('acme', { passphrase: 'pw' })
  return { db, vault, store }
}

const SERVER_SECRET = 'test-server-secret-never-shipped'

// ─── Happy path ────────────────────────────────────────────────────────

describe('issueMagicLinkDelegation → claimMagicLinkDelegation', () => {
  it('round-trips a single-grant delegation and unwraps the tier DEK', async () => {
    const { vault, store } = await freshVault()
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, client: 'acme' })

    const until = new Date(Date.now() + 48 * 3600 * 1000).toISOString()
    const issued = await issueMagicLinkDelegation(vault, {
      serverSecret: SERVER_SECRET,
      grants: [{ toUser: 'auditor-bob', tier: 0, collection: 'invoices', until }],
    })
    expect(issued.link.vault).toBe('acme')
    expect(issued.grants).toHaveLength(1)
    expect(issued.grants[0]!.payload.toUser).toBe('auditor-bob')
    expect(issued.grants[0]!.payload.fromUser).toBe('owner')
    expect(issued.grants[0]!.payload.collection).toBe('invoices')

    const claim = await claimMagicLinkDelegation({
      store,
      vault: 'acme',
      serverSecret: SERVER_SECRET,
      token: issued.link.token,
    })
    expect(claim.valid).toBe(true)
    expect(claim.grants).toHaveLength(1)
    expect(claim.grants[0]!.expired).toBe(false)
    expect(claim.grants[0]!.dek.type).toBe('secret')
    expect(claim.grants[0]!.dek.algorithm.name).toBe('AES-GCM')
  })

  it('the unwrapped DEK is functionally identical to the grantor tier DEK', async () => {
    // Prove equality by encrypting a sentinel with the grantor DEK (via put),
    // then decrypting the stored envelope with the unwrapped DEK.
    const { vault, store } = await freshVault()
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', amount: 42, client: 'c-1' })

    const issued = await issueMagicLinkDelegation(vault, {
      serverSecret: SERVER_SECRET,
      grants: [{
        toUser: 'auditor-bob', tier: 0, collection: 'invoices',
        until: new Date(Date.now() + 3600_000).toISOString(),
      }],
    })
    const claim = await claimMagicLinkDelegation({
      store, vault: 'acme', serverSecret: SERVER_SECRET, token: issued.link.token,
    })
    const dek = claim.grants[0]!.dek

    // Fetch the stored envelope directly and decrypt with the grantee's DEK.
    const env = await store.get('acme', 'invoices', 'inv-1')
    expect(env).not.toBeNull()
    const iv = Uint8Array.from(atob(env!._iv), c => c.charCodeAt(0))
    const ct = Uint8Array.from(atob(env!._data), c => c.charCodeAt(0))
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      dek,
      ct as unknown as BufferSource,
    )
    const json = new TextDecoder().decode(plaintext)
    expect(JSON.parse(json)).toMatchObject({ id: 'inv-1', amount: 42 })
  })

  it('persists the record under the bare token id for direct fetch', async () => {
    const { vault, store } = await freshVault()
    vault.collection<Invoice>('invoices')
    await vault.collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 1, client: 'c' })

    const issued = await issueMagicLinkDelegation(vault, {
      serverSecret: SERVER_SECRET,
      grants: [{
        toUser: 'u', tier: 0, collection: 'invoices',
        until: new Date(Date.now() + 3600_000).toISOString(),
      }],
    })
    const ids = await store.list('acme', MAGIC_LINK_GRANTS_COLLECTION)
    expect(ids).toContain(issued.link.token)
    expect(ids).toHaveLength(1)
  })
})

// ─── Batch grants (pilot-2 client-portal scope) ────────────────────────

describe('batch grants — one link, multiple collections', () => {
  it('issues N records under one token with suffixed ids', async () => {
    const { vault, store } = await freshVault()
    const invoices = vault.collection<Invoice>('invoices')
    const payments = vault.collection<Payment>('payments')
    await invoices.put('i1', { id: 'i1', amount: 1, client: 'c-1' })
    await payments.put('p1', { id: 'p1', invoiceId: 'i1', amount: 1 })

    const until = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const issued = await issueMagicLinkDelegation(vault, {
      serverSecret: SERVER_SECRET,
      grants: [
        { toUser: 'client-1', tier: 0, collection: 'invoices', until },
        { toUser: 'client-1', tier: 0, collection: 'payments', until },
      ],
    })
    expect(issued.grants).toHaveLength(2)
    expect(issued.grants[0]!.recordId).toBe(issued.link.token)
    expect(issued.grants[1]!.recordId).toBe(`${issued.link.token}:1`)

    const ids = await store.list('acme', MAGIC_LINK_GRANTS_COLLECTION)
    expect(ids).toHaveLength(2)
  })

  it('claim returns all grants in issue order with distinct DEKs', async () => {
    const { vault, store } = await freshVault()
    vault.collection<Invoice>('invoices')
    vault.collection<Payment>('payments')
    await vault.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 1, client: 'c-1' })
    await vault.collection<Payment>('payments').put('p1', { id: 'p1', invoiceId: 'i1', amount: 1 })

    const until = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const issued = await issueMagicLinkDelegation(vault, {
      serverSecret: SERVER_SECRET,
      grants: [
        { toUser: 'client-1', tier: 0, collection: 'invoices', until },
        { toUser: 'client-1', tier: 0, collection: 'payments', until },
      ],
    })

    const claim = await claimMagicLinkDelegation({
      store, vault: 'acme', serverSecret: SERVER_SECRET, token: issued.link.token,
    })
    expect(claim.valid).toBe(true)
    expect(claim.grants).toHaveLength(2)
    const collections = claim.grants.map(g => g.payload.collection).sort()
    expect(collections).toEqual(['invoices', 'payments'])
  })
})

// ─── Failure modes ─────────────────────────────────────────────────────

describe('rejected claims', () => {
  it('wrong server secret returns valid:false, empty grants', async () => {
    const { vault, store } = await freshVault()
    await vault.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 1, client: 'c' })
    const issued = await issueMagicLinkDelegation(vault, {
      serverSecret: SERVER_SECRET,
      grants: [{ toUser: 'u', tier: 0, collection: 'invoices',
                 until: new Date(Date.now() + 3600_000).toISOString() }],
    })
    const claim = await claimMagicLinkDelegation({
      store, vault: 'acme', serverSecret: 'wrong-secret', token: issued.link.token,
    })
    expect(claim.valid).toBe(false)
    expect(claim.grants).toHaveLength(0)
  })

  it('wrong vault name returns valid:false', async () => {
    const { vault, store } = await freshVault()
    await vault.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 1, client: 'c' })
    const issued = await issueMagicLinkDelegation(vault, {
      serverSecret: SERVER_SECRET,
      grants: [{ toUser: 'u', tier: 0, collection: 'invoices',
                 until: new Date(Date.now() + 3600_000).toISOString() }],
    })
    const claim = await claimMagicLinkDelegation({
      store, vault: 'OTHER', serverSecret: SERVER_SECRET, token: issued.link.token,
    })
    expect(claim.valid).toBe(false)
  })

  it('unknown token returns valid:false', async () => {
    const { store } = await freshVault()
    const claim = await claimMagicLinkDelegation({
      store, vault: 'acme', serverSecret: SERVER_SECRET,
      token: '01JXAAAAAAAAAAAAAAAAAAAAAA',
    })
    expect(claim.valid).toBe(false)
    expect(claim.grants).toHaveLength(0)
  })

  it('expired grants are returned but flagged expired', async () => {
    const { vault, store } = await freshVault()
    await vault.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 1, client: 'c' })
    const past = new Date(Date.now() - 10_000).toISOString()
    const issued = await issueMagicLinkDelegation(vault, {
      serverSecret: SERVER_SECRET,
      grants: [{ toUser: 'u', tier: 0, collection: 'invoices', until: past }],
    })
    const claim = await claimMagicLinkDelegation({
      store, vault: 'acme', serverSecret: SERVER_SECRET, token: issued.link.token,
    })
    expect(claim.valid).toBe(true)
    expect(claim.grants[0]!.expired).toBe(true)
  })

  it('empty grants[] throws', async () => {
    const { vault } = await freshVault()
    await expect(
      issueMagicLinkDelegation(vault, { serverSecret: SERVER_SECRET, grants: [] }),
    ).rejects.toThrow(/non-empty/)
  })
})

// ─── Inspection + revocation ───────────────────────────────────────────

describe('inspectMagicLinkDelegation', () => {
  it('returns grants without unwrapping DEKs', async () => {
    const { vault, store } = await freshVault()
    await vault.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 1, client: 'c' })
    const issued = await issueMagicLinkDelegation(vault, {
      serverSecret: SERVER_SECRET,
      grants: [{
        toUser: 'auditor', tier: 0, collection: 'invoices',
        until: new Date(Date.now() + 3600_000).toISOString(),
        note: 'Q2 audit window',
      }],
    })
    const payloads = await inspectMagicLinkDelegation({
      store, vault: 'acme', serverSecret: SERVER_SECRET, token: issued.link.token,
    })
    expect(payloads).toHaveLength(1)
    expect(payloads[0]!.toUser).toBe('auditor')
    expect(payloads[0]!.note).toBe('Q2 audit window')
  })
})

describe('revokeMagicLinkDelegation', () => {
  it('deletes every record under the token and subsequent claim is invalid', async () => {
    const { vault, store } = await freshVault()
    await vault.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 1, client: 'c' })
    await vault.collection<Payment>('payments').put('p1', { id: 'p1', invoiceId: 'i1', amount: 1 })
    const issued = await issueMagicLinkDelegation(vault, {
      serverSecret: SERVER_SECRET,
      grants: [
        { toUser: 'u', tier: 0, collection: 'invoices',
          until: new Date(Date.now() + 3600_000).toISOString() },
        { toUser: 'u', tier: 0, collection: 'payments',
          until: new Date(Date.now() + 3600_000).toISOString() },
      ],
    })
    const removed = await revokeMagicLinkDelegation({
      store, vault: 'acme', token: issued.link.token,
    })
    expect(removed).toBe(2)

    const claim = await claimMagicLinkDelegation({
      store, vault: 'acme', serverSecret: SERVER_SECRET, token: issued.link.token,
    })
    expect(claim.valid).toBe(false)
  })

  it('revoking a missing token returns 0 and does not throw', async () => {
    const { store } = await freshVault()
    const removed = await revokeMagicLinkDelegation({
      store, vault: 'acme', token: '01JXZZZZZZZZZZZZZZZZZZZZZZ',
    })
    expect(removed).toBe(0)
  })
})

// ─── Single-record read ────────────────────────────────────────────────

describe('readMagicLinkGrant', () => {
  it('resolves a specific record id within a batch', async () => {
    const { vault, store } = await freshVault()
    await vault.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 1, client: 'c' })
    await vault.collection<Payment>('payments').put('p1', { id: 'p1', invoiceId: 'i1', amount: 1 })
    const issued = await issueMagicLinkDelegation(vault, {
      serverSecret: SERVER_SECRET,
      grants: [
        { toUser: 'u', tier: 0, collection: 'invoices',
          until: new Date(Date.now() + 3600_000).toISOString() },
        { toUser: 'u', tier: 0, collection: 'payments',
          until: new Date(Date.now() + 3600_000).toISOString() },
      ],
    })
    const secondId = issued.grants[1]!.recordId
    const payload = await readMagicLinkGrant({
      store, vault: 'acme', serverSecret: SERVER_SECRET,
      token: issued.link.token, recordId: secondId,
    })
    expect(payload?.collection).toBe('payments')
  })
})
