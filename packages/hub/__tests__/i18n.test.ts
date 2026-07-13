/**
 * i18nText schema type tests — v0.8
 *
 * Covers:
 *   - i18nText validation on put (all / any / string[] modes)
 *   - MissingTranslationError on put when required langs missing
 *   - Per-call { locale, fallback } on get() and list()
 *   - Raw mode ({ locale: 'raw' }) returns full { [locale]: string } map
 *   - Vault-default locale via openVault({ locale })
 *   - LocaleNotSpecifiedError when locale chain exhausted
 *   - Fallback chain (single + multi-step + 'any')
 *   - Schema validation on put + read
 *   - orderBy on i18nText uses Intl.Collator (smoke test)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withI18n } from '../src/via/i18n/index.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import {
  MissingTranslationError,
  LocaleNotSpecifiedError,
} from '../src/kernel/errors.js'
import { i18nText, applyI18nLocale, resolveI18nText, validateI18nTextValue } from '../src/via/i18n/core.js'

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

// ─── Unit tests for i18n utilities ────────────────────────────────────

describe('resolveI18nText utility', () => {
  it('resolves primary locale', () => {
    const result = resolveI18nText({ en: 'Hello', th: 'สวัสดี' }, 'th')
    expect(result).toBe('สวัสดี')
  })

  it('returns raw map when locale is "raw"', () => {
    const map = { en: 'Hello', th: 'สวัสดี' }
    const result = resolveI18nText(map, 'raw')
    expect(result).toEqual(map)
  })

  it('falls back to single fallback locale', () => {
    const result = resolveI18nText({ en: 'Hello' }, 'th', 'en')
    expect(result).toBe('Hello')
  })

  it('falls back through ordered chain', () => {
    const result = resolveI18nText({ en: 'Hello' }, 'th', ['jp', 'en'])
    expect(result).toBe('Hello')
  })

  it('falls back to "any" available translation', () => {
    const result = resolveI18nText({ en: 'Hello' }, 'th', 'any')
    expect(result).toBe('Hello')
  })

  it('throws LocaleNotSpecifiedError when chain is exhausted', () => {
    expect(() =>
      resolveI18nText({ en: 'Hello' }, 'th', undefined, 'description'),
    ).toThrow(LocaleNotSpecifiedError)
  })
})

describe('validateI18nTextValue utility', () => {
  it('passes when all required languages are present (mode: all)', () => {
    const desc = i18nText({ languages: ['en', 'th'], required: 'all' })
    expect(() =>
      validateI18nTextValue({ en: 'Hello', th: 'สวัสดี' }, 'description', desc),
    ).not.toThrow()
  })

  it('throws MissingTranslationError when a required lang is missing (mode: all)', () => {
    const desc = i18nText({ languages: ['en', 'th'], required: 'all' })
    expect(() =>
      validateI18nTextValue({ en: 'Hello' }, 'description', desc),
    ).toThrow(MissingTranslationError)
  })

  it('passes when at least one language is present (mode: any)', () => {
    const desc = i18nText({ languages: ['en', 'th'], required: 'any' })
    expect(() =>
      validateI18nTextValue({ en: 'Hello' }, 'description', desc),
    ).not.toThrow()
  })

  it('throws MissingTranslationError when no language present (mode: any)', () => {
    const desc = i18nText({ languages: ['en', 'th'], required: 'any' })
    expect(() =>
      validateI18nTextValue({}, 'description', desc),
    ).toThrow(MissingTranslationError)
  })

  it('passes when required list languages are present (mode: string[])', () => {
    const desc = i18nText({ languages: ['en', 'th'], required: ['th'] })
    expect(() =>
      validateI18nTextValue({ th: 'สวัสดี' }, 'description', desc),
    ).not.toThrow()
  })

  it('throws MissingTranslationError when required list lang is missing (mode: string[])', () => {
    const desc = i18nText({ languages: ['en', 'th'], required: ['th'] })
    expect(() =>
      validateI18nTextValue({ en: 'Hello' }, 'description', desc),
    ).toThrow(MissingTranslationError)
  })

  it('MissingTranslationError carries the field and missing list', () => {
    const desc = i18nText({ languages: ['en', 'th'], required: 'all' })
    let error: MissingTranslationError | undefined
    try {
      validateI18nTextValue({ en: 'Hello' }, 'description', desc)
    } catch (e) {
      if (e instanceof MissingTranslationError) error = e
    }
    expect(error).toBeDefined()
    expect(error?.field).toBe('description')
    expect(error?.missing).toContain('th')
  })

  it('throws when value is not an object', () => {
    const desc = i18nText({ languages: ['en'], required: 'all' })
    expect(() =>
      validateI18nTextValue('not an object', 'description', desc),
    ).toThrow(MissingTranslationError)
  })
})

// ─── Integration tests via Collection ─────────────────────────────────

describe('i18nText — Collection integration', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice', i18nStrategy: withI18n(),
      secret: 'test-passphrase-i18n-1234',
    })
  })

  it('put and get with locale resolves the field', async () => {
    const company = await db.openVault('co1')

    type LineItem = { id: string; description: Record<string, string> }
    const items = company.collection<LineItem>('line-items', {
      i18nFields: {
        description: i18nText({ languages: ['en', 'th'], required: 'all' }),
      },
    })

    await items.put('li-1', {
      id: 'li-1',
      description: { en: 'Consulting hours', th: 'ค่าที่ปรึกษา' },
    })

    const result = await items.get('li-1', { locale: 'th' })
    expect(result?.description).toBe('ค่าที่ปรึกษา')
  })

  it('get with locale "en" resolves to English', async () => {
    const company = await db.openVault('co1')

    type LineItem = { id: string; description: Record<string, string> }
    const items = company.collection<LineItem>('line-items', {
      i18nFields: {
        description: i18nText({ languages: ['en', 'th'], required: 'all' }),
      },
    })

    await items.put('li-1', {
      id: 'li-1',
      description: { en: 'Consulting hours', th: 'ค่าที่ปรึกษา' },
    })

    const result = await items.get('li-1', { locale: 'en' })
    expect(result?.description).toBe('Consulting hours')
  })

  it('get with locale "raw" returns the full map', async () => {
    const company = await db.openVault('co1')

    type LineItem = { id: string; description: Record<string, string> }
    const items = company.collection<LineItem>('line-items', {
      i18nFields: {
        description: i18nText({ languages: ['en', 'th'], required: 'all' }),
      },
    })

    await items.put('li-1', {
      id: 'li-1',
      description: { en: 'Consulting hours', th: 'ค่าที่ปรึกษา' },
    })

    const result = await items.get('li-1', { locale: 'raw' })
    expect(result?.description).toEqual({ en: 'Consulting hours', th: 'ค่าที่ปรึกษา' })
  })

  it('get without locale returns raw map', async () => {
    const company = await db.openVault('co1')

    type LineItem = { id: string; description: Record<string, string> }
    const items = company.collection<LineItem>('line-items', {
      i18nFields: {
        description: i18nText({ languages: ['en', 'th'], required: 'any' }),
      },
    })

    await items.put('li-1', {
      id: 'li-1',
      description: { en: 'Consulting hours', th: 'ค่าที่ปรึกษา' },
    })

    const result = await items.get('li-1')
    expect(result?.description).toEqual({ en: 'Consulting hours', th: 'ค่าที่ปรึกษา' })
  })

  it('put throws MissingTranslationError when required lang missing (mode: all)', async () => {
    const company = await db.openVault('co1')

    type LineItem = { id: string; description: Record<string, string> }
    const items = company.collection<LineItem>('line-items', {
      i18nFields: {
        description: i18nText({ languages: ['en', 'th'], required: 'all' }),
      },
    })

    await expect(
      items.put('li-1', {
        id: 'li-1',
        description: { en: 'Only English' }, // missing 'th'
      }),
    ).rejects.toThrow(MissingTranslationError)
  })

  it('put allows missing optional language (mode: any)', async () => {
    const company = await db.openVault('co1')

    type LineItem = { id: string; description: Record<string, string> }
    const items = company.collection<LineItem>('line-items', {
      i18nFields: {
        description: i18nText({ languages: ['en', 'th'], required: 'any' }),
      },
    })

    // Should not throw — 'th' is not required when mode is 'any'
    await expect(
      items.put('li-1', {
        id: 'li-1',
        description: { en: 'Only English' },
      }),
    ).resolves.toBeUndefined()
  })

  it('list() with locale resolves all records', async () => {
    const company = await db.openVault('co1')

    type LineItem = { id: string; description: Record<string, string> }
    const items = company.collection<LineItem>('line-items', {
      i18nFields: {
        description: i18nText({ languages: ['en', 'th'], required: 'all' }),
      },
    })

    await items.put('li-1', {
      id: 'li-1',
      description: { en: 'Consulting', th: 'ที่ปรึกษา' },
    })
    await items.put('li-2', {
      id: 'li-2',
      description: { en: 'Design', th: 'ออกแบบ' },
    })

    const results = await items.list({ locale: 'th' })
    const li1 = results.find(r => r.id === 'li-1')
    const li2 = results.find(r => r.id === 'li-2')
    expect(li1?.description).toBe('ที่ปรึกษา')
    expect(li2?.description).toBe('ออกแบบ')
  })

  it('compartment-default locale from openVault', async () => {
    const company = await db.openVault('co1', { locale: 'th' })

    type LineItem = { id: string; description: Record<string, string> }
    const items = company.collection<LineItem>('line-items', {
      i18nFields: {
        description: i18nText({ languages: ['en', 'th'], required: 'all' }),
      },
    })

    await items.put('li-1', {
      id: 'li-1',
      description: { en: 'Consulting', th: 'ที่ปรึกษา' },
    })

    // No locale on get() — uses vault default 'th'
    const result = await items.get('li-1')
    expect(result?.description).toBe('ที่ปรึกษา')
  })

  it('per-call locale overrides vault default', async () => {
    const company = await db.openVault('co1', { locale: 'th' })

    type LineItem = { id: string; description: Record<string, string> }
    const items = company.collection<LineItem>('line-items', {
      i18nFields: {
        description: i18nText({ languages: ['en', 'th'], required: 'all' }),
      },
    })

    await items.put('li-1', {
      id: 'li-1',
      description: { en: 'Consulting', th: 'ที่ปรึกษา' },
    })

    // Per-call 'en' overrides vault default 'th'
    const result = await items.get('li-1', { locale: 'en' })
    expect(result?.description).toBe('Consulting')
  })

  it('fallback chain resolves when primary locale is missing', async () => {
    const company = await db.openVault('co1')

    type LineItem = { id: string; description: Record<string, string> }
    const items = company.collection<LineItem>('line-items', {
      i18nFields: {
        description: i18nText({ languages: ['en', 'th'], required: 'any' }),
      },
    })

    await items.put('li-1', {
      id: 'li-1',
      description: { en: 'Only English' },
    })

    // Thai not present, falls back to English
    const result = await items.get('li-1', { locale: 'th', fallback: 'en' })
    expect(result?.description).toBe('Only English')
  })

  it('throws LocaleNotSpecifiedError when locale chain exhausted', async () => {
    const company = await db.openVault('co1')

    type LineItem = { id: string; description: Record<string, string> }
    const items = company.collection<LineItem>('line-items', {
      i18nFields: {
        description: i18nText({ languages: ['en'], required: 'any' }),
      },
    })

    await items.put('li-1', {
      id: 'li-1',
      description: { en: 'Only English' },
    })

    // Thai not present, no fallback
    await expect(
      items.get('li-1', { locale: 'th' }),
    ).rejects.toThrow(LocaleNotSpecifiedError)
  })
})

// ─── Nested i18n field paths (#273) ───────────────────────────────────

describe('applyI18nLocale — nested paths (unit)', () => {
  const desc = i18nText({ languages: ['en', 'th'], required: 'any' })

  it('resolves a dot-notation path (address.lineOne)', () => {
    const record = { address: { lineOne: { th: 'ถนนไทย', en: 'Thai Rd' } } }
    const result = applyI18nLocale(
      record as Record<string, unknown>,
      { 'address.lineOne': desc },
      'th',
    )
    expect((result.address as Record<string, unknown>).lineOne).toBe('ถนนไทย')
  })

  it('resolves a deeply nested dot-notation path (a.b.c)', () => {
    const record = { a: { b: { c: { en: 'deep', th: 'ลึก' } } } }
    const result = applyI18nLocale(
      record as Record<string, unknown>,
      { 'a.b.c': desc },
      'en',
    )
    expect(((result.a as Record<string, unknown>).b as Record<string, unknown>).c).toBe('deep')
  })

  it('resolves an array-notation path (contacts[].title)', () => {
    const record = {
      contacts: [
        { name: 'Alice', title: { th: 'นาง', en: 'Mrs.' } },
        { name: 'Bob', title: { th: 'นาย', en: 'Mr.' } },
      ],
    }
    const result = applyI18nLocale(
      record as Record<string, unknown>,
      { 'contacts[].title': desc },
      'en',
    )
    const contacts = result.contacts as Array<Record<string, unknown>>
    expect(contacts[0]!.title).toBe('Mrs.')
    expect(contacts[1]!.title).toBe('Mr.')
  })

  it('leaves unrelated fields unchanged for dot-path record', () => {
    const record = { address: { lineOne: { en: 'Main St', th: 'ถนนหลัก' }, lineTwo: 'Apt 1' } }
    const result = applyI18nLocale(
      record as Record<string, unknown>,
      { 'address.lineOne': desc },
      'en',
    )
    expect((result.address as Record<string, unknown>).lineTwo).toBe('Apt 1')
  })
})

describe('i18nText — nested field paths (Collection integration)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
      i18nStrategy: withI18n(),
      secret: 'test-passphrase-nested-i18n',
    })
  })

  it('put and get resolves a dot-notation i18n field', async () => {
    const vault = await db.openVault('v-nested-1')
    type Doc = { id: string; address: { lineOne: Record<string, string> | string } }
    const docs = vault.collection<Doc>('docs', {
      i18nFields: {
        'address.lineOne': i18nText({ languages: ['th', 'en'], required: ['th'] }),
      },
    })
    await docs.put('d1', { id: 'd1', address: { lineOne: { th: 'ถนนไทย', en: 'Thai Rd' } } })
    const row = await docs.get('d1', { locale: 'th' }) as { id: string; address: { lineOne: string } }
    expect(row?.address.lineOne).toBe('ถนนไทย')
  })

  it('put validates a required dot-notation i18n field (enforceI18nOnPut)', async () => {
    const vault = await db.openVault('v-nested-2')
    type Doc = { id: string; address: { lineOne: Record<string, string> } }
    const docs = vault.collection<Doc>('docs', {
      i18nFields: {
        'address.lineOne': i18nText({ languages: ['th', 'en'], required: ['th'] }),
      },
    })
    await expect(
      docs.put('d1', { id: 'd1', address: { lineOne: { en: 'Thai Rd' } } }),
    ).rejects.toThrow(MissingTranslationError)
  })

  it('put and get resolves an array-path i18n field (contacts[].title)', async () => {
    const vault = await db.openVault('v-nested-3')
    type Doc = {
      id: string
      contacts: Array<{ name: string; title: Record<string, string> | string }>
    }
    const docs = vault.collection<Doc>('docs', {
      i18nFields: {
        'contacts[].title': i18nText({ languages: ['th', 'en'], required: 'any' }),
      },
    })
    await docs.put('d1', {
      id: 'd1',
      contacts: [
        { name: 'Alice', title: { th: 'นาง', en: 'Mrs.' } },
        { name: 'Bob', title: { th: 'นาย', en: 'Mr.' } },
      ],
    })
    const row = await docs.get('d1', { locale: 'en' }) as {
      id: string
      contacts: Array<{ name: string; title: string }>
    }
    expect(row?.contacts[0]!.title).toBe('Mrs.')
    expect(row?.contacts[1]!.title).toBe('Mr.')
  })
})
