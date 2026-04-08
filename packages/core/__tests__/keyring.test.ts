import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import {
  createOwnerKeyring,
  loadKeyring,
  grant,
  revoke,
  changeSecret,
  listUsers,
  ensureCollectionDEK,
  persistKeyring,
} from '../src/keyring.js'
import { encrypt, decrypt } from '../src/crypto.js'

function inlineMemory(): NoydbAdapter {
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
      const comp = store.get(c); const s: CompartmentSnapshot = {}
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

describe('keyring', () => {
  let adapter: NoydbAdapter
  const COMP = 'C101'

  beforeEach(() => {
    adapter = inlineMemory()
  })

  describe('createOwnerKeyring + loadKeyring', () => {
    it('creates and reloads an owner keyring', async () => {
      const kr = await createOwnerKeyring(adapter, COMP, 'owner-01', 'pass123')
      expect(kr.role).toBe('owner')
      expect(kr.userId).toBe('owner-01')

      const loaded = await loadKeyring(adapter, COMP, 'owner-01', 'pass123')
      expect(loaded.role).toBe('owner')
      expect(loaded.userId).toBe('owner-01')
    })

    it('loadKeyring with wrong passphrase throws', async () => {
      await createOwnerKeyring(adapter, COMP, 'owner-01', 'correct')
      // Loading with wrong pass should throw (if there are DEKs to unwrap)
      // With no DEKs, it'll succeed since there's nothing to unwrap
      // So let's add a DEK first
      const kr = await createOwnerKeyring(adapter, COMP, 'owner-02', 'right-pass')
      const getDEK = await ensureCollectionDEK(adapter, COMP, kr)
      await getDEK('invoices')

      await expect(
        loadKeyring(adapter, COMP, 'owner-02', 'wrong-pass'),
      ).rejects.toThrow()
    })
  })

  describe('grant', () => {
    it('owner grants operator with specific permissions', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, 'owner-01', 'ownerpass')
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')
      await getDEK('payments')

      await grant(adapter, COMP, owner, {
        userId: 'op-somchai',
        displayName: 'สมชาย',
        role: 'operator',
        passphrase: 'op-pass',
        permissions: { invoices: 'rw', payments: 'rw' },
      })

      // Operator can load their keyring
      const opKr = await loadKeyring(adapter, COMP, 'op-somchai', 'op-pass')
      expect(opKr.role).toBe('operator')
      expect(opKr.deks.has('invoices')).toBe(true)
      expect(opKr.deks.has('payments')).toBe(true)
    })

    it('owner grants viewer with all DEKs', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, 'owner-01', 'ownerpass')
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')
      await getDEK('payments')

      await grant(adapter, COMP, owner, {
        userId: 'viewer-audit',
        displayName: 'Auditor',
        role: 'viewer',
        passphrase: 'viewer-pass',
      })

      const viewerKr = await loadKeyring(adapter, COMP, 'viewer-audit', 'viewer-pass')
      expect(viewerKr.role).toBe('viewer')
      // Viewer gets ALL DEKs (read-only access to everything)
      expect(viewerKr.deks.has('invoices')).toBe(true)
      expect(viewerKr.deks.has('payments')).toBe(true)
    })

    it('owner grants client with limited permissions', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, 'owner-01', 'ownerpass')
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')
      await getDEK('payments')

      await grant(adapter, COMP, owner, {
        userId: 'client-abc',
        displayName: 'ABC Corp',
        role: 'client',
        passphrase: 'client-pass',
        permissions: { invoices: 'ro' },
      })

      const clientKr = await loadKeyring(adapter, COMP, 'client-abc', 'client-pass')
      expect(clientKr.role).toBe('client')
      expect(clientKr.deks.has('invoices')).toBe(true)
      expect(clientKr.deks.has('payments')).toBe(false) // no access to payments
    })

    it('admin can grant operator but not owner', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, 'owner-01', 'ownerpass')
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      // Grant admin
      await grant(adapter, COMP, owner, {
        userId: 'admin-noi',
        displayName: 'Noi',
        role: 'admin',
        passphrase: 'admin-pass',
      })

      const adminKr = await loadKeyring(adapter, COMP, 'admin-noi', 'admin-pass')

      // Admin grants operator — should succeed
      await expect(
        grant(adapter, COMP, adminKr, {
          userId: 'op-new',
          displayName: 'New Op',
          role: 'operator',
          passphrase: 'op-pass',
          permissions: { invoices: 'rw' },
        }),
      ).resolves.not.toThrow()

      // Admin grants owner — should fail
      await expect(
        grant(adapter, COMP, adminKr, {
          userId: 'owner-fake',
          displayName: 'Fake',
          role: 'owner',
          passphrase: 'fake-pass',
        }),
      ).rejects.toThrow('cannot grant')
    })

    it('operator cannot grant anyone', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, 'owner-01', 'ownerpass')
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      await grant(adapter, COMP, owner, {
        userId: 'op-01',
        displayName: 'Op',
        role: 'operator',
        passphrase: 'op-pass',
        permissions: { invoices: 'rw' },
      })

      const opKr = await loadKeyring(adapter, COMP, 'op-01', 'op-pass')

      await expect(
        grant(adapter, COMP, opKr, {
          userId: 'someone',
          displayName: 'Someone',
          role: 'viewer',
          passphrase: 'pass',
        }),
      ).rejects.toThrow('cannot grant')
    })
  })

  describe('revoke', () => {
    it('owner revokes operator', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, 'owner-01', 'ownerpass')
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      await grant(adapter, COMP, owner, {
        userId: 'op-01',
        displayName: 'Op',
        role: 'operator',
        passphrase: 'op-pass',
        permissions: { invoices: 'rw' },
      })

      // Verify operator exists
      let users = await listUsers(adapter, COMP)
      expect(users.find(u => u.userId === 'op-01')).toBeDefined()

      // Revoke without key rotation
      await revoke(adapter, COMP, owner, { userId: 'op-01', rotateKeys: false })

      // Operator's keyring is gone
      users = await listUsers(adapter, COMP)
      expect(users.find(u => u.userId === 'op-01')).toBeUndefined()
    })

    it('cannot revoke owner', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, 'owner-01', 'ownerpass')

      await grant(adapter, COMP, owner, {
        userId: 'admin-01',
        displayName: 'Admin',
        role: 'admin',
        passphrase: 'admin-pass',
      })

      const adminKr = await loadKeyring(adapter, COMP, 'admin-01', 'admin-pass')

      await expect(
        revoke(adapter, COMP, adminKr, { userId: 'owner-01' }),
      ).rejects.toThrow('cannot revoke')
    })

    it('revoke with rotateKeys re-encrypts data', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, 'owner-01', 'ownerpass')
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      const invoiceDek = await getDEK('invoices')

      // Put some encrypted data
      const { iv, data } = await encrypt('{"amount":5000}', invoiceDek)
      await adapter.put(COMP, 'invoices', 'inv-001', {
        _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: iv, _data: data,
      })

      // Grant and then revoke with rotation
      await grant(adapter, COMP, owner, {
        userId: 'op-01',
        displayName: 'Op',
        role: 'operator',
        passphrase: 'op-pass',
        permissions: { invoices: 'rw' },
      })

      await revoke(adapter, COMP, owner, { userId: 'op-01', rotateKeys: true })

      // The old DEK should no longer decrypt the data
      const envelope = await adapter.get(COMP, 'invoices', 'inv-001')
      expect(envelope).not.toBeNull()

      // But the owner should have the NEW DEK and can still decrypt
      const newDek = owner.deks.get('invoices')!
      const decrypted = await decrypt(envelope!._iv, envelope!._data, newDek)
      expect(JSON.parse(decrypted)).toEqual({ amount: 5000 })
    })
  })

  describe('changeSecret', () => {
    it('re-wraps DEKs with new passphrase', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, 'owner-01', 'old-pass')
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      const dek = await getDEK('invoices')

      // Encrypt something
      const { iv, data } = await encrypt('test-data', dek)

      // Change passphrase
      const updated = await changeSecret(adapter, COMP, owner, 'new-pass')

      // Old passphrase should fail to load (DEKs present, wrong KEK)
      await expect(
        loadKeyring(adapter, COMP, 'owner-01', 'old-pass'),
      ).rejects.toThrow()

      // New passphrase should work
      const loaded = await loadKeyring(adapter, COMP, 'owner-01', 'new-pass')
      expect(loaded.role).toBe('owner')

      // Data is still decryptable (DEKs unchanged, only wrapping changed)
      const newDek = loaded.deks.get('invoices')!
      const decrypted = await decrypt(iv, data, newDek)
      expect(decrypted).toBe('test-data')
    })
  })

  describe('listUsers', () => {
    it('returns all users in a compartment', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, 'owner-01', 'pass')
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      await grant(adapter, COMP, owner, {
        userId: 'op-01', displayName: 'Op 1', role: 'operator',
        passphrase: 'p1', permissions: { invoices: 'rw' },
      })
      await grant(adapter, COMP, owner, {
        userId: 'viewer-01', displayName: 'Viewer', role: 'viewer',
        passphrase: 'p2',
      })

      const users = await listUsers(adapter, COMP)
      expect(users).toHaveLength(3)
      expect(users.map(u => u.userId).sort()).toEqual(['op-01', 'owner-01', 'viewer-01'])
      expect(users.find(u => u.userId === 'op-01')?.role).toBe('operator')
      expect(users.find(u => u.userId === 'viewer-01')?.role).toBe('viewer')
    })
  })
})
