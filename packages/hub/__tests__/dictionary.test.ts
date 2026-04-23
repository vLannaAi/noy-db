/**
 * dictKey + DictionaryHandle tests — v0.8 #81
 *
 * Covers:
 *   - DictionaryHandle CRUD (put, putAll, get, delete, list)
 *   - DictionaryHandle.rename() — rewrites referencing records
 *   - Reserved `_dict_*` name policy (ReservedCollectionNameError)
 *   - Per-call `{ locale }` on collection.get() and list()
 *   - `<field>Label` virtual field on reads
 *   - DictKeyMissingError on rename/delete of unknown key
 *   - ACL: write permission check (operator attempting admin-only write)
 *   - Vault-default locale via openVault({ locale })
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import {
  ReservedCollectionNameError,
  DictKeyMissingError,
  PermissionDeniedError,
} from '../src/errors.js'
import { dictKey } from '../src/i18n/dictionary.js'

// ─── Inline memory adapter ─────────────────────────────────────────────

function memory(): NoydbStore {
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

// ─── Tests ──────────────────────────────────────────────────────────────

describe('DictionaryHandle — CRUD (#81)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'test-passphrase-dict-1234',
    })
  })

  it('put and get a single entry', async () => {
    const company = await db.openVault('co1')
    const dict = company.dictionary('status')

    await dict.put('paid', { en: 'Paid', th: 'ชำระแล้ว' })

    const labels = await dict.get('paid')
    expect(labels).toEqual({ en: 'Paid', th: 'ชำระแล้ว' })
  })

  it('get returns null for missing key', async () => {
    const company = await db.openVault('co1')
    const dict = company.dictionary('status')

    const labels = await dict.get('nonexistent')
    expect(labels).toBeNull()
  })

  it('putAll writes multiple entries', async () => {
    const company = await db.openVault('co1')
    const dict = company.dictionary('status')

    await dict.putAll({
      draft: { en: 'Draft', th: 'ฉบับร่าง' },
      open:  { en: 'Open',  th: 'เปิด' },
      paid:  { en: 'Paid',  th: 'ชำระแล้ว' },
    })

    const entries = await dict.list()
    expect(entries).toHaveLength(3)
    const keys = entries.map(e => e.key).sort()
    expect(keys).toEqual(['draft', 'open', 'paid'])
  })

  it('list returns all entries with labels', async () => {
    const company = await db.openVault('co1')
    const dict = company.dictionary('status')

    await dict.putAll({
      draft: { en: 'Draft', th: 'ฉบับร่าง' },
      paid:  { en: 'Paid',  th: 'ชำระแล้ว' },
    })

    const entries = await dict.list()
    const draftEntry = entries.find(e => e.key === 'draft')
    expect(draftEntry?.labels).toEqual({ en: 'Draft', th: 'ฉบับร่าง' })
  })

  it('put overwrites an existing entry', async () => {
    const company = await db.openVault('co1')
    const dict = company.dictionary('status')

    await dict.put('paid', { en: 'Paid', th: 'ชำระแล้ว' })
    await dict.put('paid', { en: 'Paid (updated)', th: 'ชำระแล้ว (อัปเดต)' })

    const labels = await dict.get('paid')
    expect(labels).toEqual({ en: 'Paid (updated)', th: 'ชำระแล้ว (อัปเดต)' })
  })

  it('delete removes an entry', async () => {
    const company = await db.openVault('co1')
    const dict = company.dictionary('status')

    await dict.put('paid', { en: 'Paid', th: 'ชำระแล้ว' })
    await dict.delete('paid')

    const labels = await dict.get('paid')
    expect(labels).toBeNull()
  })

  it('delete throws DictKeyMissingError for unknown key', async () => {
    const company = await db.openVault('co1')
    const dict = company.dictionary('status')

    await expect(dict.delete('nonexistent')).rejects.toThrow(DictKeyMissingError)
  })

  it('resolveLabel returns the label for a locale', async () => {
    const company = await db.openVault('co1')
    const dict = company.dictionary('status')

    await dict.put('paid', { en: 'Paid', th: 'ชำระแล้ว' })

    const label = await dict.resolveLabel('paid', 'th')
    expect(label).toBe('ชำระแล้ว')
  })

  it('resolveLabel falls back to fallback locale', async () => {
    const company = await db.openVault('co1')
    const dict = company.dictionary('status')

    await dict.put('paid', { en: 'Paid' })

    const label = await dict.resolveLabel('paid', 'th', 'en')
    expect(label).toBe('Paid')
  })

  it('resolveLabel returns undefined for missing key', async () => {
    const company = await db.openVault('co1')
    const dict = company.dictionary('status')

    const label = await dict.resolveLabel('nonexistent', 'en')
    expect(label).toBeUndefined()
  })
})

describe('DictionaryHandle.rename() (#81)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'test-passphrase-dict-1234',
    })
  })

  it('renames a key and updates referencing records', async () => {
    const company = await db.openVault('co1')

    await company.dictionary('status').putAll({
      paid: { en: 'Paid', th: 'ชำระแล้ว' },
    })

    type Invoice = { id: string; status: string }
    const invoices = company.collection<Invoice>('invoices', {
      dictKeyFields: { status: dictKey('status') },
    })

    await invoices.put('inv-1', { id: 'inv-1', status: 'paid' })
    await invoices.put('inv-2', { id: 'inv-2', status: 'paid' })

    // Rename 'paid' → 'settled'
    await company.dictionary('status').rename('paid', 'settled')

    // Old key is gone
    expect(await company.dictionary('status').get('paid')).toBeNull()

    // New key exists with same labels
    const newLabels = await company.dictionary('status').get('settled')
    expect(newLabels).toEqual({ en: 'Paid', th: 'ชำระแล้ว' })

    // Records have been updated
    const inv1 = await invoices.get('inv-1')
    expect(inv1?.status).toBe('settled')
    const inv2 = await invoices.get('inv-2')
    expect(inv2?.status).toBe('settled')
  })

  it('throws DictKeyMissingError when renaming a non-existent key', async () => {
    const company = await db.openVault('co1')

    await expect(
      company.dictionary('status').rename('nonexistent', 'new'),
    ).rejects.toThrow(DictKeyMissingError)
  })
})

describe('Reserved _dict_* name policy (#81)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'test-passphrase-dict-1234',
    })
  })

  it('throws ReservedCollectionNameError for _dict_* names', async () => {
    const company = await db.openVault('co1')

    expect(() => company.collection('_dict_status')).toThrow(ReservedCollectionNameError)
    expect(() => company.collection('_dict_')).toThrow(ReservedCollectionNameError)
    expect(() => company.collection('_dict_anything')).toThrow(ReservedCollectionNameError)
  })

  it('allows regular underscore-prefixed internal names (not _dict_)', async () => {
    // _ledger, _keyring etc. have their own guards; just confirm our
    // guard is narrow and only blocks _dict_* names.
    const company = await db.openVault('co1')
    // Should not throw ReservedCollectionNameError specifically for non-dict names
    expect(() => company.collection('statuses')).not.toThrow(ReservedCollectionNameError)
  })
})

describe('dictKey — per-call locale reads (#81)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'test-passphrase-dict-1234',
    })
  })

  it('get() with locale adds <field>Label virtual field', async () => {
    const company = await db.openVault('co1')

    await company.dictionary('status').putAll({
      paid: { en: 'Paid', th: 'ชำระแล้ว' },
    })

    type Invoice = { id: string; status: string }
    const invoices = company.collection<Invoice>('invoices', {
      dictKeyFields: { status: dictKey('status', ['paid', 'draft'] as const) },
    })

    await invoices.put('inv-1', { id: 'inv-1', status: 'paid' })

    const result = await invoices.get('inv-1', { locale: 'th' }) as Invoice & { statusLabel?: string }
    expect(result?.status).toBe('paid')
    expect(result?.statusLabel).toBe('ชำระแล้ว')
  })

  it('get() with EN locale uses English label', async () => {
    const company = await db.openVault('co1')

    await company.dictionary('status').putAll({
      paid: { en: 'Paid', th: 'ชำระแล้ว' },
    })

    type Invoice = { id: string; status: string }
    const invoices = company.collection<Invoice>('invoices', {
      dictKeyFields: { status: dictKey('status') },
    })

    await invoices.put('inv-1', { id: 'inv-1', status: 'paid' })

    const result = await invoices.get('inv-1', { locale: 'en' }) as Invoice & { statusLabel?: string }
    expect(result?.statusLabel).toBe('Paid')
  })

  it('list() with locale adds labels to all records', async () => {
    const company = await db.openVault('co1')

    await company.dictionary('status').putAll({
      draft: { en: 'Draft', th: 'ฉบับร่าง' },
      paid:  { en: 'Paid',  th: 'ชำระแล้ว' },
    })

    type Invoice = { id: string; status: string }
    const invoices = company.collection<Invoice>('invoices', {
      dictKeyFields: { status: dictKey('status') },
    })

    await invoices.put('inv-1', { id: 'inv-1', status: 'paid' })
    await invoices.put('inv-2', { id: 'inv-2', status: 'draft' })

    const results = await invoices.list({ locale: 'th' }) as Array<Invoice & { statusLabel?: string }>
    const paid = results.find(r => r.id === 'inv-1')
    const draft = results.find(r => r.id === 'inv-2')
    expect(paid?.statusLabel).toBe('ชำระแล้ว')
    expect(draft?.statusLabel).toBe('ฉบับร่าง')
  })

  it('get() without locale does NOT add label', async () => {
    const company = await db.openVault('co1')

    await company.dictionary('status').putAll({
      paid: { en: 'Paid', th: 'ชำระแล้ว' },
    })

    type Invoice = { id: string; status: string }
    const invoices = company.collection<Invoice>('invoices', {
      dictKeyFields: { status: dictKey('status') },
    })

    await invoices.put('inv-1', { id: 'inv-1', status: 'paid' })

    const result = await invoices.get('inv-1') as Invoice & { statusLabel?: string }
    expect(result?.status).toBe('paid')
    expect(result?.statusLabel).toBeUndefined()
  })

  it('compartment-default locale (openVault with locale)', async () => {
    const company = await db.openVault('co1', { locale: 'th' })

    await company.dictionary('status').putAll({
      paid: { en: 'Paid', th: 'ชำระแล้ว' },
    })

    type Invoice = { id: string; status: string }
    const invoices = company.collection<Invoice>('invoices', {
      dictKeyFields: { status: dictKey('status') },
    })

    await invoices.put('inv-1', { id: 'inv-1', status: 'paid' })

    // No explicit locale on get() — uses vault default
    const result = await invoices.get('inv-1') as Invoice & { statusLabel?: string }
    expect(result?.statusLabel).toBe('ชำระแล้ว')
  })

  it('per-call locale overrides vault default', async () => {
    const company = await db.openVault('co1', { locale: 'th' })

    await company.dictionary('status').putAll({
      paid: { en: 'Paid', th: 'ชำระแล้ว' },
    })

    type Invoice = { id: string; status: string }
    const invoices = company.collection<Invoice>('invoices', {
      dictKeyFields: { status: dictKey('status') },
    })

    await invoices.put('inv-1', { id: 'inv-1', status: 'paid' })

    // Per-call locale overrides the 'th' default
    const result = await invoices.get('inv-1', { locale: 'en' }) as Invoice & { statusLabel?: string }
    expect(result?.statusLabel).toBe('Paid')
  })
})

describe('dictKey ACL — write permissions (#81)', () => {
  it('throws PermissionDeniedError when client tries to write a default admin-only dict', async () => {
    // Set up owner, then grant client access
    const adp = memory()
    const ownerDb = await createNoydb({
      store: adp,
      user: 'owner',
      secret: 'test-passphrase-dict-1234',
    })

    const ownerCo = await ownerDb.openVault('company')
    // First create the vault (init keyring for owner)
    ownerCo.collection('init')

    // Grant client access
    await ownerDb.grant('company', {
      userId: 'client',
      displayName: 'Client User',
      role: 'client',
      passphrase: 'client-passphrase-dict-1234',
    })

    // Client opens the same vault
    const clientDb = await createNoydb({
      store: adp,
      user: 'client',
      secret: 'client-passphrase-dict-1234',
    })
    const clientCo = await clientDb.openVault('company')
    const clientDict = clientCo.dictionary('status')

    await expect(clientDict.put('paid', { en: 'Paid' })).rejects.toThrow(
      PermissionDeniedError,
    )
  })

  it('allows operator write when writableBy is set to operator', async () => {
    const adp = memory()
    const ownerDb = await createNoydb({
      store: adp,
      user: 'owner',
      secret: 'test-passphrase-dict-1234',
    })

    const ownerCo = await ownerDb.openVault('company')
    ownerCo.collection('init')

    await ownerDb.grant('company', {
      userId: 'op',
      displayName: 'Operator',
      role: 'operator',
      passphrase: 'op-passphrase-dict-1234',
      permissions: { '*': 'rw' },
    })

    const opDb = await createNoydb({
      store: adp,
      user: 'op',
      secret: 'op-passphrase-dict-1234',
    })
    const opCo = await opDb.openVault('company')
    const opDict = opCo.dictionary('status', { writableBy: 'operator' })

    // Should not throw
    await expect(opDict.put('paid', { en: 'Paid' })).resolves.toBeUndefined()
  })
})
