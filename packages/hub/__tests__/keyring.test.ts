import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, ValidationError } from '../src/kernel/errors.js'
import {
  createOwnerKeyring,
  loadKeyring,
  grant,
  revoke,
  changeSecret,
  listUsers,
  ensureCollectionDEK,
  persistKeyring,
  buildRecipientKeyringFile,
} from '../src/with-party/team/keyring.js'
import { buildRecordAad, recordAadFor, encrypt, decrypt } from '../src/kernel/enclave/index.js'

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

describe('keyring', () => {
  let adapter: NoydbStore
  const COMP = 'C101'

  beforeEach(() => {
    adapter = inlineMemory()
  })

  describe('createOwnerKeyring + loadKeyring', () => {
    it('creates and reloads an owner keyring', async () => {
      const kr = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'pass123' })
      expect(kr.role).toBe('owner')
      expect(kr.userId).toBe('owner-01')

      const loaded = await loadKeyring(adapter, COMP, { userId: 'owner-01', secret: 'pass123' })
      expect(loaded.role).toBe('owner')
      expect(loaded.userId).toBe('owner-01')
    })

    it('loadKeyring with wrong secret throws', async () => {
      await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'correct' })
      // Loading with wrong pass should throw (if there are DEKs to unwrap)
      // With no DEKs, it'll succeed since there's nothing to unwrap
      // So let's add a DEK first
      const kr = await createOwnerKeyring(adapter, COMP, { userId: 'owner-02', secret: 'right-pass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, kr)
      await getDEK('invoices')

      await expect(
        loadKeyring(adapter, COMP, { userId: 'owner-02', secret: 'wrong-pass' }),
      ).rejects.toThrow()
    })
  })

  describe('grant', () => {
    it('owner grants operator with specific permissions', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'ownerpass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')
      await getDEK('payments')

      await grant(adapter, COMP, owner, {
        userId: 'op-somchai',
        displayName: 'สมชาย',
        role: 'operator',
        secret: 'op-pass',
        permissions: { invoices: 'rw', payments: 'rw' },
      })

      // Operator can load their keyring
      const opKr = await loadKeyring(adapter, COMP, { userId: 'op-somchai', secret: 'op-pass' })
      expect(opKr.role).toBe('operator')
      expect(opKr.deks.has('invoices')).toBe(true)
      expect(opKr.deks.has('payments')).toBe(true)
    })

    it('owner grants viewer with all DEKs', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'ownerpass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')
      await getDEK('payments')

      await grant(adapter, COMP, owner, {
        userId: 'viewer-audit',
        displayName: 'Auditor',
        role: 'viewer',
        secret: 'viewer-pass',
      })

      const viewerKr = await loadKeyring(adapter, COMP, { userId: 'viewer-audit', secret: 'viewer-pass' })
      expect(viewerKr.role).toBe('viewer')
      // Viewer gets ALL DEKs (read-only access to everything)
      expect(viewerKr.deks.has('invoices')).toBe(true)
      expect(viewerKr.deks.has('payments')).toBe(true)
    })

    it('owner grants client with limited permissions', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'ownerpass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')
      await getDEK('payments')

      await grant(adapter, COMP, owner, {
        userId: 'client-abc',
        displayName: 'ABC Corp',
        role: 'client',
        secret: 'client-pass',
        permissions: { invoices: 'ro' },
      })

      const clientKr = await loadKeyring(adapter, COMP, { userId: 'client-abc', secret: 'client-pass' })
      expect(clientKr.role).toBe('client')
      expect(clientKr.deks.has('invoices')).toBe(true)
      expect(clientKr.deks.has('payments')).toBe(false) // no access to payments
    })

    it('admin can grant operator but not owner', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'ownerpass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      // Grant admin
      await grant(adapter, COMP, owner, {
        userId: 'admin-noi',
        displayName: 'Noi',
        role: 'admin',
        secret: 'admin-pass',
      })

      const adminKr = await loadKeyring(adapter, COMP, { userId: 'admin-noi', secret: 'admin-pass' })

      // Admin grants operator — should succeed
      await expect(
        grant(adapter, COMP, adminKr, {
          userId: 'op-new',
          displayName: 'New Op',
          role: 'operator',
          secret: 'op-pass',
          permissions: { invoices: 'rw' },
        }),
      ).resolves.not.toThrow()

      // Admin grants owner — should fail
      await expect(
        grant(adapter, COMP, adminKr, {
          userId: 'owner-fake',
          displayName: 'Fake',
          role: 'owner',
          secret: 'fake-pass',
        }),
      ).rejects.toThrow('cannot grant')
    })

    it('operator cannot grant anyone', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'ownerpass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      await grant(adapter, COMP, owner, {
        userId: 'op-01',
        displayName: 'Op',
        role: 'operator',
        secret: 'op-pass',
        permissions: { invoices: 'rw' },
      })

      const opKr = await loadKeyring(adapter, COMP, { userId: 'op-01', secret: 'op-pass' })

      await expect(
        grant(adapter, COMP, opKr, {
          userId: 'someone',
          displayName: 'Someone',
          role: 'viewer',
          secret: 'pass',
        }),
      ).rejects.toThrow('cannot grant')
    })

    it('rejects when caller kek is null (tier-2 wrap-DEKs / tier-3 PIN-resume sessions cannot grant)', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'ownerpass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      // Simulate a tier-2 wrap-DEKs unlock (e.g. @noy-db/on-password) or tier-3
      // PIN-resume: same DEKs in memory, but kek is null because the slot
      // wraps DEKs directly without producing a KEK.
      const tier2Caller = { ...owner, kek: null }

      await expect(
        grant(adapter, COMP, tier2Caller, {
          userId: 'mallory',
          displayName: 'Mallory',
          role: 'admin',
          secret: 'attacker-pass',
        }),
      ).rejects.toThrow(ValidationError)
    })
  })

  describe('revoke', () => {
    it('owner revokes operator', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'ownerpass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      await grant(adapter, COMP, owner, {
        userId: 'op-01',
        displayName: 'Op',
        role: 'operator',
        secret: 'op-pass',
        permissions: { invoices: 'rw' },
      })

      // Verify operator exists
      let users = await listUsers(adapter, COMP)
      expect(users.find(u => u.userId === 'op-01')).toBeDefined()

      // Revoke without key rotation
      await revoke(adapter, COMP, owner, { userId: 'op-01' })

      // Operator's keyring is gone
      users = await listUsers(adapter, COMP)
      expect(users.find(u => u.userId === 'op-01')).toBeUndefined()
    })

    it('cannot revoke owner', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'ownerpass' })

      await grant(adapter, COMP, owner, {
        userId: 'admin-01',
        displayName: 'Admin',
        role: 'admin',
        secret: 'admin-pass',
      })

      const adminKr = await loadKeyring(adapter, COMP, { userId: 'admin-01', secret: 'admin-pass' })

      await expect(
        revoke(adapter, COMP, adminKr, { userId: 'owner-01' }),
      ).rejects.toThrow('cannot revoke')
    })

    it('revoke with rotateKeys re-encrypts data', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'ownerpass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      const invoiceDek = await getDEK('invoices')

      // Put some encrypted data
      // #1041: seal against the address it is stored at, as the product does.
      const { iv, data } = await encrypt('{"amount":5000}', invoiceDek, buildRecordAad({ collection: 'invoices', id: 'inv-001' }))
      await adapter.put(COMP, 'invoices', 'inv-001', {
        _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: iv, _data: data,
      })

      // Grant and then revoke with rotation
      await grant(adapter, COMP, owner, {
        userId: 'op-01',
        displayName: 'Op',
        role: 'operator',
        secret: 'op-pass',
        permissions: { invoices: 'rw' },
      })

      await revoke(adapter, COMP, owner, { userId: 'op-01' })

      const envelope = await adapter.get(COMP, 'invoices', 'inv-001')
      expect(envelope).not.toBeNull()

      // Owner must be able to decrypt with the NEW DEK
      const newDek = owner.deks.get('invoices')!
      const decrypted = await decrypt(envelope!._iv, envelope!._data, newDek, recordAadFor({ collection: 'invoices', id: 'inv-001' }, envelope!))
      expect(JSON.parse(decrypted)).toEqual({ amount: 5000 })

      // Critical: the OLD DEK (captured before rotation) must no longer decrypt
      // If it does, key rotation is ineffective — a revoked user who saved their
      // DEK copy could still read all past and future records.
      expect(newDek).not.toBe(invoiceDek) // sanity: rotation produced a new key object
      await expect(decrypt(envelope!._iv, envelope!._data, invoiceDek, recordAadFor({ collection: 'invoices', id: 'inv-001' }, envelope!))).rejects.toThrow()
    })
  })

  describe('changeSecret', () => {
    it('re-wraps DEKs with new secret', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'old-pass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      const dek = await getDEK('invoices')

      // Encrypt something
      const { iv, data } = await encrypt('test-data', dek)

      // Change secret (test exercises rewrap, not strength validation)
      const updated = await changeSecret(adapter, COMP, owner, { newSecret: 'new-pass', allowWeakSecret: true })

      // Old secret should fail to load (DEKs present, wrong KEK)
      await expect(
        loadKeyring(adapter, COMP, { userId: 'owner-01', secret: 'old-pass' }),
      ).rejects.toThrow()

      // New secret should work
      const loaded = await loadKeyring(adapter, COMP, { userId: 'owner-01', secret: 'new-pass' })
      expect(loaded.role).toBe('owner')

      // Data is still decryptable (DEKs unchanged, only wrapping changed)
      const newDek = loaded.deks.get('invoices')!
      const decrypted = await decrypt(iv, data, newDek)
      expect(decrypted).toBe('test-data')
    })

    it('rejects a weak new secret by default', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'correct horse battery staple printer toaster' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      await expect(
        changeSecret(adapter, COMP, owner, { newSecret: 'weak' }),
      ).rejects.toThrow()
    })

    it('accepts a weak new secret when allowWeakSecret: true', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'correct horse battery staple printer toaster' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      await expect(
        changeSecret(adapter, COMP, owner, { newSecret: 'weak', allowWeakSecret: true }),
      ).resolves.toBeDefined()
    })
  })

  describe('listUsers', () => {
    it('returns all users in a compartment', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'pass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      await grant(adapter, COMP, owner, {
        userId: 'op-01', displayName: 'Op 1', role: 'operator',
        secret: 'p1', permissions: { invoices: 'rw' },
      })
      await grant(adapter, COMP, owner, {
        userId: 'viewer-01', displayName: 'Viewer', role: 'viewer',
        secret: 'p2',
      })

      const users = await listUsers(adapter, COMP)
      expect(users).toHaveLength(3)
      expect(users.map(u => u.userId).sort()).toEqual(['op-01', 'owner-01', 'viewer-01'])
      expect(users.find(u => u.userId === 'op-01')?.role).toBe('operator')
      expect(users.find(u => u.userId === 'viewer-01')?.role).toBe('viewer')
    })
  })

  describe('buildRecipientKeyringFile (issue #112)', () => {
    it('rejects when caller kek is null (tier-2 wrap-DEKs / tier-3 PIN-resume sessions cannot mint bundle recipients)', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'ownerpass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      // Same shape as the grant() tier-2 test: simulate an
      // @noy-db/on-password unlock or tier-3 PIN-resume by spreading
      // the owner keyring with kek replaced by null. The DEKs are still
      // in memory; only the KEK is missing — exactly the state #81's
      // grant guard rejected. buildRecipientKeyringFile shipped without
      // the same guard until #112.
      const tier2Caller = { ...owner, kek: null }

      await expect(
        buildRecipientKeyringFile(tier2Caller, {
          id: 'recipient-01',
          displayName: 'Recipient',
          role: 'admin',
          secret: 'a strong recipient secret here',
        }),
      ).rejects.toThrow(ValidationError)
    })

    it('still works for legitimate tier-1 callers', async () => {
      const owner = await createOwnerKeyring(adapter, COMP, { userId: 'owner-01', secret: 'ownerpass' })
      const getDEK = await ensureCollectionDEK(adapter, COMP, owner)
      await getDEK('invoices')

      const file = await buildRecipientKeyringFile(owner, {
        id: 'recipient-01',
        displayName: 'Recipient',
        role: 'viewer',
        secret: 'a strong recipient secret here',
      })

      expect(file.user_id).toBe('recipient-01')
      expect(file.role).toBe('viewer')
      expect(Object.keys(file.deks).length).toBeGreaterThan(0)
    })
  })
})
