/**
 * carryLedger opt-in (#205, slice 1) — Plan 7. Carry the source _ledger
 * audit chain into an extracted partition: filtered to the closure,
 * re-chained, payloadHash recomputed against re-keyed data.
 *
 * The gating test is `verifyBackupIntegrity()` on the adopted+owned vault.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withCargo } from '../src/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { ref } from '../src/kernel/refs.js'
import { ConflictError } from '../src/kernel/errors.js'
import { generateDEK, decrypt } from '../src/kernel/enclave/index.js'
import { hashEntry } from '../src/with-commit/history/ledger/entry.js'
import { envelopePayloadHash } from '../src/with-commit/history/ledger/hash.js'
import type { LedgerEntry } from '../src/with-commit/history/ledger/entry.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { reKeyLedger, reKeyClosure, extractPartition } from '../src/with-cargo/extract-partition.js'
import { adoptPartition, createOwnerOnAdoptedPartition } from '../src/with-cargo/adopt-partition.js'
import { readNoydbBundle, parseExtractedPartitionBody } from '../src/with-pod/bundle.js'

function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
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
  }
}

interface Client { id: string; name: string; operatorUserId: string }

async function srcVault() {
  const db = await createNoydb({ cargoStrategy: withCargo(), store: toMemory(), user: 'alice', secret: 'pw-1234', historyStrategy: withHistory() })
  const c = await db.openVault('demo-co')
  const clients = c.collection<Client>('clients')
  const bills = c.collection<{ id: string; clientId: string }>('bills', { refs: { clientId: ref('clients') } })
  await clients.put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
  await clients.put('c-2', { id: 'c-2', name: 'Shop', operatorUserId: 'ann' }) // NOT in closure
  await bills.put('b-1', { id: 'b-1', clientId: 'c-1' })
  return c
}

async function bundleBody(bytes: Uint8Array) {
  const { dump } = parseExtractedPartitionBody((await readNoydbBundle(bytes)).dumpJson)
  return JSON.parse(dump) as {
    _internal?: { _ledger?: Record<string, unknown> }
    ledgerHead?: { hash: string; index: number }
  }
}

describe('reKeyLedger', () => {
  it('carries only closure entries, re-chained + payloadHash recomputed against re-keyed data', async () => {
    const company = await srcVault()
    const closure = new Map([['clients', new Set(['c-1'])], ['bills', new Set(['b-1'])]])
    const { collections } = await reKeyClosure(company, closure)

    const ledgerDek = await generateDEK()
    const result = await reKeyLedger(company, closure, collections, ledgerDek)

    const ids = Object.keys(result.entries).sort()
    expect(ids.length).toBeGreaterThan(0)

    const carried: LedgerEntry[] = []
    for (const id of ids) {
      const env = result.entries[id]!
      carried.push(JSON.parse(await decrypt(env._iv, env._data, ledgerDek)) as LedgerEntry)
    }
    expect(carried.some((e) => e.id === 'c-2')).toBe(false) // ann's client, outside closure
    expect(carried[0]!.index).toBe(0)
    expect(carried[0]!.prevHash).toBe('')
    for (let i = 1; i < carried.length; i++) {
      expect(carried[i]!.index).toBe(i)
      expect(carried[i]!.prevHash).toBe(await hashEntry(carried[i - 1]!))
    }
    const c1 = [...carried].reverse().find((e) => e.collection === 'clients' && e.id === 'c-1' && e.op === 'put')!
    expect(c1.payloadHash).toBe(await envelopePayloadHash(collections['clients']!['c-1']!))
    expect(result.head.index).toBe(carried.length - 1)
    expect(result.head.hash).toBe(await hashEntry(carried[carried.length - 1]!))
  })

  it('recomputes payloadHash ONLY for the latest put (option a): intermediate puts keep source hash', async () => {
    const db = await createNoydb({ cargoStrategy: withCargo(), store: toMemory(), user: 'alice', secret: 'pw-1234', historyStrategy: withHistory() })
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients')
    await clients.put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })       // v1
    await clients.put('c-1', { id: 'c-1', name: 'Hotel Renamed', operatorUserId: 'belle' }) // v2 (latest)

    const closure = new Map([['clients', new Set(['c-1'])]])
    const { collections } = await reKeyClosure(company, closure)
    const ledgerDek = await generateDEK()
    const { entries } = await reKeyLedger(company, closure, collections, ledgerDek)

    const carried: LedgerEntry[] = []
    for (const id of Object.keys(entries).sort()) {
      const env = entries[id]!
      carried.push(JSON.parse(await decrypt(env._iv, env._data, ledgerDek)) as LedgerEntry)
    }
    const puts = carried.filter((e) => e.collection === 'clients' && e.id === 'c-1' && e.op === 'put')
    expect(puts.length).toBe(2) // both versions carried (audit fidelity)
    // Latest put: payloadHash matches the re-keyed (current) envelope.
    expect(puts[1]!.payloadHash).toBe(await envelopePayloadHash(collections['clients']!['c-1']!))
    // Intermediate put: a DIFFERENT hash (its source value, not recomputed to current).
    expect(puts[0]!.payloadHash).not.toBe(puts[1]!.payloadHash)
  })
})

describe('extractPartition carryLedger — non-destructive on the source', () => {
  it('does not mint a phantom _ledger DEK in the source keyring when the source has no history', async () => {
    // Source vault opened WITHOUT withHistory(): keyring has no _ledger DEK.
    // carryLedger: true on such a vault must not auto-mint and persist one
    // (contradicts the "non-destructive on the source" module-level claim).
    const sourceStore = toMemory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store: sourceStore, user: 'alice', secret: 'pw-1234' })
    const vault = await db.openVault('demo-co')
    await vault.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })

    const before = JSON.parse((await sourceStore.get('demo-co', '_keyring', 'alice'))!._data) as { deks: Record<string, unknown> }
    expect(before.deks).not.toHaveProperty('_ledger')

    await extractPartition(vault, { seeds: { clients: () => true }, carryLedger: true })

    const after = JSON.parse((await sourceStore.get('demo-co', '_keyring', 'alice'))!._data) as { deks: Record<string, unknown> }
    expect(after.deks).not.toHaveProperty('_ledger')
  })
})

describe('extractPartition carryLedger', () => {
  it('carries _internal._ledger + ledgerHead when carryLedger: true', async () => {
    const company = await srcVault()
    const { bundleBytes } = await extractPartition(company, {
      seeds: { clients: (c) => c.operatorUserId === 'belle' },
      carryLedger: true,
    })
    const body = await bundleBody(bundleBytes)
    expect(Object.keys(body._internal?._ledger ?? {}).length).toBeGreaterThan(0)
    expect(body.ledgerHead?.hash.length).toBeGreaterThan(0)
  })

  it('omits the ledger by default', async () => {
    const company = await srcVault()
    const { bundleBytes } = await extractPartition(company, { seeds: { clients: (c) => c.operatorUserId === 'belle' } })
    const body = await bundleBody(bundleBytes)
    expect(body._internal?._ledger).toBeUndefined()
    expect(body.ledgerHead).toBeUndefined()
  })
})

describe('carryLedger full ceremony — verifyBackupIntegrity', () => {
  it('the recipient vault verifies the carried chain over re-keyed data', async () => {
    const company = await srcVault()
    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { clients: (c) => c.operatorUserId === 'belle' }, carryLedger: true,
    })

    const dest = toMemory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    await createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', secret: 'belle-2026', transferKey })

    const recipientDb = await createNoydb({ cargoStrategy: withCargo(), store: dest, user: 'belle', secret: 'belle-2026', historyStrategy: withHistory() })
    const vault = await recipientDb.openVault('acme')

    const result = await vault.verifyBackupIntegrity()
    expect(result.ok).toBe(true)
    expect(await vault.collection<Client>('clients').get('c-1')).toMatchObject({ id: 'c-1', name: 'Hotel' })
  })
})
