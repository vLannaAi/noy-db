import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, ReadOnlyError, PermissionDeniedError, NoAccessError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
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
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

interface Invoice { amount: number; status: string }

describe('access control: permission matrix', () => {
  let adapter: NoydbStore
  let ownerDb: Noydb
  const COMP = 'C101'

  beforeEach(async () => {
    adapter = inlineMemory()
    ownerDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })

    // Seed data: owner writes to invoices and payments
    const comp = await ownerDb.openVault(COMP)
    const invoices = comp.collection<Invoice>('invoices')
    const payments = comp.collection<Invoice>('payments')
    await invoices.put('inv-001', { amount: 5000, status: 'draft' })
    await payments.put('pay-001', { amount: 3000, status: 'paid' })
  })

  describe('owner', () => {
    it('can read all collections', async () => {
      const comp = await ownerDb.openVault(COMP)
      const inv = await comp.collection<Invoice>('invoices').get('inv-001')
      expect(inv?.amount).toBe(5000)
      const pay = await comp.collection<Invoice>('payments').get('pay-001')
      expect(pay?.amount).toBe(3000)
    })

    it('can write all collections', async () => {
      const comp = await ownerDb.openVault(COMP)
      await expect(
        comp.collection<Invoice>('invoices').put('inv-002', { amount: 1000, status: 'new' }),
      ).resolves.not.toThrow()
    })

    it('can grant all roles', async () => {
      await expect(
        ownerDb.grant(COMP, { userId: 'admin-01', displayName: 'Admin', role: 'admin', passphrase: 'p' }),
      ).resolves.not.toThrow()
      await expect(
        ownerDb.grant(COMP, { userId: 'op-01', displayName: 'Op', role: 'operator', passphrase: 'p', permissions: { invoices: 'rw' } }),
      ).resolves.not.toThrow()
      await expect(
        ownerDb.grant(COMP, { userId: 'viewer-01', displayName: 'V', role: 'viewer', passphrase: 'p' }),
      ).resolves.not.toThrow()
      await expect(
        ownerDb.grant(COMP, { userId: 'client-01', displayName: 'C', role: 'client', passphrase: 'p', permissions: { invoices: 'ro' } }),
      ).resolves.not.toThrow()
    })

    it('can revoke non-owner roles', async () => {
      await ownerDb.grant(COMP, { userId: 'op-01', displayName: 'Op', role: 'operator', passphrase: 'p', permissions: { invoices: 'rw' } })
      await expect(
        ownerDb.revoke(COMP, { userId: 'op-01', rotateKeys: false }),
      ).resolves.not.toThrow()
    })

    it('can export every collection', async () => {
      const comp = await ownerDb.openVault(COMP)
      const json = await comp.exportJSON()
      const parsed = JSON.parse(json) as { collections: Record<string, unknown> }
      expect(parsed.collections).toHaveProperty('invoices')
    })
  })

  describe('admin', () => {
    let adminDb: Noydb

    beforeEach(async () => {
      await ownerDb.grant(COMP, { userId: 'admin-01', displayName: 'Admin', role: 'admin', passphrase: 'admin-pass' })
      adminDb = await createNoydb({ store: adapter, user: 'admin-01', secret: 'admin-pass' })
    })

    it('can read all collections', async () => {
      const comp = await adminDb.openVault(COMP)
      const inv = await comp.collection<Invoice>('invoices').get('inv-001')
      expect(inv?.amount).toBe(5000)
    })

    it('can write all collections', async () => {
      const comp = await adminDb.openVault(COMP)
      await expect(
        comp.collection<Invoice>('invoices').put('inv-new', { amount: 100, status: 'x' }),
      ).resolves.not.toThrow()
    })

    it('can grant operator, viewer, client', async () => {
      await expect(
        adminDb.grant(COMP, { userId: 'op-from-admin', displayName: 'Op', role: 'operator', passphrase: 'p', permissions: { invoices: 'rw' } }),
      ).resolves.not.toThrow()
    })

    it('cannot grant owner', async () => {
      await expect(
        adminDb.grant(COMP, { userId: 'fake-owner', displayName: 'X', role: 'owner', passphrase: 'p' }),
      ).rejects.toThrow(PermissionDeniedError)
    })

    it('can grant another admin (v0.5 #62 — bounded delegation)', async () => {
      // v0.5 opens admin↔admin lateral delegation. The v0.4 rule was
      // "only owner can grant admin" — this is the explicit counter-
      // assertion. Full coverage of the feature (including cascade on
      // revoke and the subset rule) lives in admin-delegation.test.ts.
      await expect(
        adminDb.grant(COMP, {
          userId: 'admin-from-admin',
          displayName: 'Peer Admin',
          role: 'admin',
          passphrase: 'p',
        }),
      ).resolves.not.toThrow()
    })

    it('cannot revoke owner', async () => {
      await expect(
        adminDb.revoke(COMP, { userId: 'owner-01' }),
      ).rejects.toThrow(PermissionDeniedError)
    })
  })

  describe('operator', () => {
    let opDb: Noydb

    beforeEach(async () => {
      await ownerDb.grant(COMP, {
        userId: 'op-01', displayName: 'Op', role: 'operator',
        passphrase: 'op-pass',
        permissions: { invoices: 'rw' },
      })
      opDb = await createNoydb({ store: adapter, user: 'op-01', secret: 'op-pass' })
    })

    it('can read permitted collections', async () => {
      const comp = await opDb.openVault(COMP)
      const inv = await comp.collection<Invoice>('invoices').get('inv-001')
      expect(inv?.amount).toBe(5000)
    })

    it('can write permitted collections', async () => {
      const comp = await opDb.openVault(COMP)
      await expect(
        comp.collection<Invoice>('invoices').put('inv-new', { amount: 100, status: 'x' }),
      ).resolves.not.toThrow()
    })

    it('cannot grant anyone', async () => {
      await expect(
        opDb.grant(COMP, { userId: 'x', displayName: 'X', role: 'viewer', passphrase: 'p' }),
      ).rejects.toThrow(PermissionDeniedError)
    })

    it('cannot revoke anyone', async () => {
      // Grant another user first via owner
      await ownerDb.grant(COMP, { userId: 'viewer-01', displayName: 'V', role: 'viewer', passphrase: 'p' })
      await expect(
        opDb.revoke(COMP, { userId: 'viewer-01' }),
      ).rejects.toThrow(PermissionDeniedError)
    })

    it('export is ACL-scoped — operator sees only permitted collections', async () => {
      // v0.5 #72: exportStream/exportJSON are no longer owner-only.
      // They silently scope to collections the caller can read, matching
      // the same hasAccess() rule as Collection.list().
      const comp = await opDb.openVault(COMP)
      const json = await comp.exportJSON()
      const parsed = JSON.parse(json) as { collections: Record<string, unknown> }
      // Operator was granted invoices: 'rw' only — that's the only
      // collection that should appear in the export.
      expect(Object.keys(parsed.collections)).toEqual(['invoices'])
    })
  })

  describe('viewer', () => {
    let viewerDb: Noydb

    beforeEach(async () => {
      await ownerDb.grant(COMP, {
        userId: 'viewer-01', displayName: 'Viewer', role: 'viewer',
        passphrase: 'viewer-pass',
      })
      viewerDb = await createNoydb({ store: adapter, user: 'viewer-01', secret: 'viewer-pass' })
    })

    it('can read all collections', async () => {
      const comp = await viewerDb.openVault(COMP)
      const inv = await comp.collection<Invoice>('invoices').get('inv-001')
      expect(inv?.amount).toBe(5000)
    })

    it('cannot write any collection', async () => {
      const comp = await viewerDb.openVault(COMP)
      await expect(
        comp.collection<Invoice>('invoices').put('inv-bad', { amount: 0, status: 'x' }),
      ).rejects.toThrow(ReadOnlyError)
    })

    it('cannot delete', async () => {
      const comp = await viewerDb.openVault(COMP)
      await expect(
        comp.collection<Invoice>('invoices').delete('inv-001'),
      ).rejects.toThrow(ReadOnlyError)
    })

    it('cannot grant anyone', async () => {
      await expect(
        viewerDb.grant(COMP, { userId: 'x', displayName: 'X', role: 'viewer', passphrase: 'p' }),
      ).rejects.toThrow(PermissionDeniedError)
    })
  })

  describe('client', () => {
    let clientDb: Noydb

    beforeEach(async () => {
      await ownerDb.grant(COMP, {
        userId: 'client-01', displayName: 'Client', role: 'client',
        passphrase: 'client-pass',
        permissions: { invoices: 'ro' },
      })
      clientDb = await createNoydb({ store: adapter, user: 'client-01', secret: 'client-pass' })
    })

    it('can read permitted collections', async () => {
      const comp = await clientDb.openVault(COMP)
      const inv = await comp.collection<Invoice>('invoices').get('inv-001')
      expect(inv?.amount).toBe(5000)
    })

    it('cannot write permitted collections (read-only)', async () => {
      const comp = await clientDb.openVault(COMP)
      await expect(
        comp.collection<Invoice>('invoices').put('inv-bad', { amount: 0, status: 'x' }),
      ).rejects.toThrow(ReadOnlyError)
    })

    it('cannot grant anyone', async () => {
      await expect(
        clientDb.grant(COMP, { userId: 'x', displayName: 'X', role: 'viewer', passphrase: 'p' }),
      ).rejects.toThrow(PermissionDeniedError)
    })
  })
})
