/**
 * dictKey + DictionaryHandle tests — v0.8
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
import { createNoydb } from '../src/kernel/noydb.js'
import { withI18n } from '../src/shape/via-i18n/index.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import {
  ReservedCollectionNameError,
  DictKeyMissingError,
  PermissionDeniedError,
  StaticDictReadonlyError,
  UnknownDictCodeError,
} from '../src/kernel/errors.js'
import { dictKey, staticDict } from '../src/shape/via-i18n/dictionary.js'
import { withAggregate, count } from '../src/with-lookup/aggregate/index.js'
import { withTeam } from '../src/with-party/team/index.js'

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

describe('DictionaryHandle — CRUD', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({ teamStrategy: withTeam(),
      store: memory(),
      user: 'alice', i18nStrategy: withI18n(),
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

describe('DictionaryHandle.rename()', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({ teamStrategy: withTeam(),
      store: memory(),
      user: 'alice', i18nStrategy: withI18n(),
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

describe('Reserved _dict_* name policy', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({ teamStrategy: withTeam(),
      store: memory(),
      user: 'alice', i18nStrategy: withI18n(),
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

describe('dictKey — per-call locale reads', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({ teamStrategy: withTeam(),
      store: memory(),
      user: 'alice', i18nStrategy: withI18n(),
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

describe('dictKey ACL — write permissions', () => {
  it('throws PermissionDeniedError when client tries to write a default admin-only dict', async () => {
    // Set up owner, then grant client access
    const adp = memory()
    const ownerDb = await createNoydb({ teamStrategy: withTeam(),
      store: adp,
      user: 'owner', i18nStrategy: withI18n(),
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
    const clientDb = await createNoydb({ teamStrategy: withTeam(),
      store: adp,
      user: 'client', i18nStrategy: withI18n(),
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
    const ownerDb = await createNoydb({ teamStrategy: withTeam(),
      store: adp,
      user: 'owner', i18nStrategy: withI18n(),
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

    const opDb = await createNoydb({ teamStrategy: withTeam(),
      store: adp,
      user: 'op', i18nStrategy: withI18n(),
      secret: 'op-passphrase-dict-1234',
    })
    const opCo = await opDb.openVault('company')
    const opDict = opCo.dictionary('status', { writableBy: 'operator' })

    // Should not throw
    await expect(opDict.put('paid', { en: 'Paid' })).resolves.toBeUndefined()
  })
})

// ─── staticDict (code-provided dictionary, #291) ────────────────────────

const CIVIL_STATUS = {
  adultMale:   { th: 'นาย',   en: 'Mr'  },
  adultFemale: { th: 'นาง',   en: 'Mrs' },
  youngFemale: { th: 'นางสาว', en: 'Ms' },
} as const

interface Worker { id: string; civilStatus: string }

describe('staticDict — code-provided dictionary (#291)', () => {
  it('resolves <field>Label locale-less via displayLocale', async () => {
    const db = await createNoydb({ teamStrategy: withTeam(),
      store: memory(), user: 'alice', i18nStrategy: withI18n(),
      secret: 'test-passphrase-static-1',
    })
    // No locale on the vault — the hybrid hinge.
    const vault = await db.openVault('co1')
    const workers = vault.collection<Worker>('workers', {
      dictKeyFields: { civilStatus: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th' }) },
    })
    await workers.put('w1', { id: 'w1', civilStatus: 'adultMale' })

    const r = await workers.get('w1') as Worker & { civilStatusLabel?: string }
    expect(r?.civilStatus).toBe('adultMale')      // record still stores the code
    expect(r?.civilStatusLabel).toBe('นาย')       // resolved via displayLocale
  })

  it('WITHOUT displayLocale does NOT resolve locale-less (dictKey parity)', async () => {
    const db = await createNoydb({ teamStrategy: withTeam(),
      store: memory(), user: 'alice', i18nStrategy: withI18n(),
      secret: 'test-passphrase-static-2',
    })
    const vault = await db.openVault('co1')
    const workers = vault.collection<Worker>('workers', {
      dictKeyFields: { civilStatus: staticDict('civilStatus', CIVIL_STATUS) },
    })
    await workers.put('w1', { id: 'w1', civilStatus: 'adultMale' })

    const r = await workers.get('w1') as Worker & { civilStatusLabel?: string }
    expect(r?.civilStatusLabel).toBeUndefined()   // no displayLocale → no label
    // …but resolves once a locale is supplied per-call.
    const en = await workers.get('w1', { locale: 'en' }) as Worker & { civilStatusLabel?: string }
    expect(en?.civilStatusLabel).toBe('Mr')
  })

  it('locale-active read resolves via the in-code table', async () => {
    const db = await createNoydb({ teamStrategy: withTeam(),
      store: memory(), user: 'alice', i18nStrategy: withI18n(),
      secret: 'test-passphrase-static-3',
    })
    const vault = await db.openVault('co1', { locale: 'en' })
    const workers = vault.collection<Worker>('workers', {
      dictKeyFields: { civilStatus: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th' }) },
    })
    await workers.put('w1', { id: 'w1', civilStatus: 'adultFemale' })

    const r = await workers.get('w1') as Worker & { civilStatusLabel?: string }
    expect(r?.civilStatusLabel).toBe('Mrs')        // active locale wins over displayLocale
  })

  it('vault.dictionary(staticName) throws StaticDictReadonlyError', async () => {
    const db = await createNoydb({ teamStrategy: withTeam(),
      store: memory(), user: 'alice', i18nStrategy: withI18n(),
      secret: 'test-passphrase-static-4',
    })
    const vault = await db.openVault('co1')
    vault.collection<Worker>('workers', {
      dictKeyFields: { civilStatus: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th' }) },
    })
    expect(() => vault.dictionary('civilStatus')).toThrow(StaticDictReadonlyError)
  })

  it('put() with an unknown code throws UnknownDictCodeError', async () => {
    const db = await createNoydb({ teamStrategy: withTeam(),
      store: memory(), user: 'alice', i18nStrategy: withI18n(),
      secret: 'test-passphrase-static-5',
    })
    const vault = await db.openVault('co1')
    const workers = vault.collection<Worker>('workers', {
      dictKeyFields: { civilStatus: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th' }) },
    })
    await expect(
      workers.put('w1', { id: 'w1', civilStatus: 'notAKey' }),
    ).rejects.toThrow(UnknownDictCodeError)
  })

  it('validateCodes:false allows an open code', async () => {
    const db = await createNoydb({ teamStrategy: withTeam(),
      store: memory(), user: 'alice', i18nStrategy: withI18n(),
      secret: 'test-passphrase-static-6',
    })
    const vault = await db.openVault('co1')
    const workers = vault.collection<Worker>('workers', {
      dictKeyFields: {
        civilStatus: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th', validateCodes: false }),
      },
    })
    await expect(
      workers.put('w1', { id: 'w1', civilStatus: 'openCode' }),
    ).resolves.not.toThrow()
    const r = await workers.get('w1') as Worker
    expect(r?.civilStatus).toBe('openCode')
  })

  it('groupBy(field) buckets by the stable code', async () => {
    const db = await createNoydb({ teamStrategy: withTeam(),
      store: memory(), user: 'alice',
      i18nStrategy: withI18n(), aggregateStrategy: withAggregate(),
      secret: 'test-passphrase-static-7',
    })
    const vault = await db.openVault('co1')
    const workers = vault.collection<Worker>('workers', {
      dictKeyFields: { civilStatus: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th' }) },
    })
    await workers.put('w1', { id: 'w1', civilStatus: 'adultMale' })
    await workers.put('w2', { id: 'w2', civilStatus: 'adultMale' })
    await workers.put('w3', { id: 'w3', civilStatus: 'adultFemale' })

    const rows = workers.query().groupBy('civilStatus').aggregate({ n: count() }).run() as Array<{ civilStatus: string; n: number }>
    const byCode = Object.fromEntries(rows.map((r) => [r.civilStatus, r.n]))
    expect(byCode['adultMale']).toBe(2)
    expect(byCode['adultFemale']).toBe(1)
  })
})

// ─── dictKey inline labels (#485) ────────────────────────────────────────────

describe('dictKey inline labels (#485)', () => {
  it('map form: keys inferred, labels captured', () => {
    const d = dictKey('saleStatus', { draft: 'Draft', to_verify: 'To Verify' })
    expect(d.keys).toEqual(['draft', 'to_verify'])
    expect(d.labels).toEqual({ draft: 'Draft', to_verify: 'To Verify' })
  })
  it('array + opts.labels', () => {
    const d = dictKey('saleStatus', ['draft', 'to_verify'] as const, { labels: { to_verify: 'To Verify' } })
    expect(d.keys).toEqual(['draft', 'to_verify'])
    expect(d.labels).toEqual({ to_verify: 'To Verify' })
  })
  it('bare array unchanged (no labels)', () => {
    const d = dictKey('saleStatus', ['draft', 'paid'] as const)
    expect(d.keys).toEqual(['draft', 'paid'])
    expect(d.labels).toBeUndefined()
  })
})
