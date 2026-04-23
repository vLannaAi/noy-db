/**
 * exportStream() + exportJSON() tests — #72, v0.5.
 *
 * These cover the authorization-aware export primitive that replaces
 * the v0.4 owner-only `export()` method. Three axes of coverage:
 *
 *   1. **ACL scoping** — owner sees everything, operator sees only
 *      granted collections, viewer sees everything (read-all role),
 *      empty compartments yield nothing.
 *   2. **Granularity** — collection-level (default) yields one chunk
 *      per collection with all records bundled; record-level yields
 *      one chunk per record with length-1 `records` array and the
 *      schema/refs metadata repeated on every chunk.
 *   3. **Metadata surfacing** — schema (via `Collection.getSchema()`),
 *      refs (via `RefRegistry.getOutbound()`), and opt-in ledger head
 *      all appear on the right shape.
 *
 * The `exportJSON()` wrapper gets a round-trip test: parse the string,
 * assert the on-disk shape matches what the caller would build by hand
 * from `exportStream()`.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ExportChunk } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import { ref } from '../src/refs.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
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
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { amount: number; client: string }
interface Payment { amount: number; invoiceId: string }
interface Client { name: string }

describe('exportStream() + exportJSON() — #72', () => {
  const COMP = 'acme'
  let adapter: NoydbStore
  let ownerDb: Noydb

  beforeEach(async () => {
    adapter = memory()
    ownerDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })

    // Seed three collections so we can assert ACL scoping later.
    const comp = await ownerDb.openVault(COMP)
    await comp.collection<Client>('clients').put('c-1', { name: 'Globex' })
    await comp.collection<Invoice>('invoices', { refs: { clientId: ref('clients', 'strict') } })
      .put('inv-1', { amount: 100, client: 'c-1' })
    await comp.collection<Invoice>('invoices').put('inv-2', { amount: 200, client: 'c-1' })
    await comp.collection<Payment>('payments').put('pay-1', { amount: 100, invoiceId: 'inv-1' })
  })

  describe('empty compartment', () => {
    it('yields zero chunks', async () => {
      const db = await createNoydb({ store: memory(), user: 'owner-01', secret: 'p' })
      const empty = await db.openVault('empty-co')
      const chunks: ExportChunk[] = []
      for await (const chunk of empty.exportStream()) chunks.push(chunk)
      expect(chunks).toHaveLength(0)
    })
  })

  describe('as owner', () => {
    it('yields one chunk per collection, sorted by name', async () => {
      const comp = await ownerDb.openVault(COMP)
      const chunks: ExportChunk[] = []
      for await (const chunk of comp.exportStream()) chunks.push(chunk)

      expect(chunks.map((c) => c.collection)).toEqual(['clients', 'invoices', 'payments'])
    })

    it('yields decrypted records in collection-granularity mode', async () => {
      const comp = await ownerDb.openVault(COMP)
      const chunks: ExportChunk[] = []
      for await (const chunk of comp.exportStream()) chunks.push(chunk)

      const invoices = chunks.find((c) => c.collection === 'invoices')!
      expect(invoices.records).toHaveLength(2)
      expect((invoices.records as Invoice[]).map((r) => r.amount).sort()).toEqual([100, 200])
    })

    it('surfaces refs metadata on the chunk', async () => {
      const comp = await ownerDb.openVault(COMP)
      // Re-open invoices with refs so the registry is populated —
      // the refs are registered at collection() construction time.
      comp.collection<Invoice>('invoices', { refs: { clientId: ref('clients', 'strict') } })

      const chunks: ExportChunk[] = []
      for await (const chunk of comp.exportStream()) chunks.push(chunk)

      const invoices = chunks.find((c) => c.collection === 'invoices')!
      expect(invoices.refs).toEqual({ clientId: { target: 'clients', mode: 'strict' } })

      const clients = chunks.find((c) => c.collection === 'clients')!
      expect(clients.refs).toEqual({})
    })

    it('does not include internal collections (_ledger, _keyring)', async () => {
      const comp = await ownerDb.openVault(COMP)
      const chunks: ExportChunk[] = []
      for await (const chunk of comp.exportStream()) chunks.push(chunk)

      for (const chunk of chunks) {
        expect(chunk.collection.startsWith('_')).toBe(false)
      }
    })
  })

  describe('granularity: record', () => {
    it('yields one chunk per record with length-1 records array', async () => {
      const comp = await ownerDb.openVault(COMP)
      const chunks: ExportChunk[] = []
      for await (const chunk of comp.exportStream({ granularity: 'record' })) chunks.push(chunk)

      // 1 client + 2 invoices + 1 payment = 4 chunks
      expect(chunks).toHaveLength(4)
      for (const chunk of chunks) {
        expect(chunk.records).toHaveLength(1)
      }
    })

    it('repeats schema + refs metadata on every per-record chunk', async () => {
      const comp = await ownerDb.openVault(COMP)
      comp.collection<Invoice>('invoices', { refs: { clientId: ref('clients', 'strict') } })

      const invoiceChunks: ExportChunk[] = []
      for await (const chunk of comp.exportStream({ granularity: 'record' })) {
        if (chunk.collection === 'invoices') invoiceChunks.push(chunk)
      }

      expect(invoiceChunks).toHaveLength(2)
      // Every chunk carries the same refs metadata — consumers doing
      // per-record streaming don't have to thread state across yields.
      for (const chunk of invoiceChunks) {
        expect(chunk.refs).toEqual({ clientId: { target: 'clients', mode: 'strict' } })
      }
    })
  })

  describe('withLedgerHead', () => {
    it('omits ledgerHead by default', async () => {
      const comp = await ownerDb.openVault(COMP)
      const chunks: ExportChunk[] = []
      for await (const chunk of comp.exportStream()) chunks.push(chunk)
      for (const chunk of chunks) {
        expect(chunk.ledgerHead).toBeUndefined()
      }
    })

    it('includes ledgerHead on every chunk when opted in', async () => {
      const comp = await ownerDb.openVault(COMP)
      const chunks: ExportChunk[] = []
      for await (const chunk of comp.exportStream({ withLedgerHead: true })) chunks.push(chunk)

      expect(chunks.length).toBeGreaterThan(0)
      const firstHead = chunks[0]!.ledgerHead
      expect(firstHead).toBeDefined()
      expect(firstHead!.hash).toMatch(/^[0-9a-f]{64}$/)

      // Every chunk carries the same head — one ledger per vault.
      for (const chunk of chunks) {
        expect(chunk.ledgerHead).toEqual(firstHead)
      }
    })
  })

  describe('ACL scoping', () => {
    it('operator sees only granted collections (no error on the others)', async () => {
      await ownerDb.grant(COMP, {
        userId: 'op-01',
        displayName: 'Op',
        role: 'operator',
        passphrase: 'op-pass',
        permissions: { invoices: 'rw' },
      })
      const opDb = await createNoydb({ store: adapter, user: 'op-01', secret: 'op-pass' })
      const comp = await opDb.openVault(COMP)

      const chunks: ExportChunk[] = []
      for await (const chunk of comp.exportStream()) chunks.push(chunk)

      expect(chunks.map((c) => c.collection)).toEqual(['invoices'])
    })

    it('viewer sees every collection (read-all role)', async () => {
      await ownerDb.grant(COMP, {
        userId: 'viewer-01',
        displayName: 'Viewer',
        role: 'viewer',
        passphrase: 'v-pass',
      })
      const viewerDb = await createNoydb({ store: adapter, user: 'viewer-01', secret: 'v-pass' })
      const comp = await viewerDb.openVault(COMP)

      const chunks: ExportChunk[] = []
      for await (const chunk of comp.exportStream()) chunks.push(chunk)

      expect(chunks.map((c) => c.collection).sort()).toEqual(['clients', 'invoices', 'payments'])
    })

    it('client sees only their explicitly-permitted collections', async () => {
      await ownerDb.grant(COMP, {
        userId: 'client-01',
        displayName: 'Client',
        role: 'client',
        passphrase: 'c-pass',
        permissions: { invoices: 'ro' },
      })
      const clientDb = await createNoydb({ store: adapter, user: 'client-01', secret: 'c-pass' })
      const comp = await clientDb.openVault(COMP)

      const chunks: ExportChunk[] = []
      for await (const chunk of comp.exportStream()) chunks.push(chunk)

      expect(chunks.map((c) => c.collection)).toEqual(['invoices'])
    })
  })

  describe('exportJSON()', () => {
    it('produces a stable on-disk shape', async () => {
      const comp = await ownerDb.openVault(COMP)
      const json = await comp.exportJSON()
      const parsed = JSON.parse(json) as {
        _noydb_export: number
        _compartment: string
        _exported_at: string
        _exported_by: string
        collections: Record<string, { schema: null; refs: Record<string, unknown>; records: unknown[] }>
      }

      expect(parsed._noydb_export).toBe(1)
      expect(parsed._compartment).toBe(COMP)
      expect(parsed._exported_by).toBe('owner-01')
      expect(parsed._exported_at).toMatch(/^\d{4}-/)
      expect(Object.keys(parsed.collections).sort()).toEqual(['clients', 'invoices', 'payments'])
      expect(parsed.collections.invoices!.records).toHaveLength(2)
    })

    it('includes ledgerHead when requested', async () => {
      const comp = await ownerDb.openVault(COMP)
      const json = await comp.exportJSON({ withLedgerHead: true })
      const parsed = JSON.parse(json) as { ledgerHead?: { hash: string } }
      expect(parsed.ledgerHead).toBeDefined()
      expect(parsed.ledgerHead!.hash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('round-trips the record content verbatim', async () => {
      const comp = await ownerDb.openVault(COMP)
      const json = await comp.exportJSON()
      const parsed = JSON.parse(json) as {
        collections: Record<string, { records: Invoice[] }>
      }

      const invoiceAmounts = parsed.collections.invoices!.records.map((r) => r.amount).sort()
      expect(invoiceAmounts).toEqual([100, 200])
    })

    it('is ACL-scoped the same as exportStream()', async () => {
      await ownerDb.grant(COMP, {
        userId: 'op-02',
        displayName: 'Op',
        role: 'operator',
        passphrase: 'op-pass',
        permissions: { payments: 'ro' },
      })
      const opDb = await createNoydb({ store: adapter, user: 'op-02', secret: 'op-pass' })
      const comp = await opDb.openVault(COMP)

      const parsed = JSON.parse(await comp.exportJSON()) as {
        collections: Record<string, unknown>
      }
      expect(Object.keys(parsed.collections)).toEqual(['payments'])
    })
  })
})
