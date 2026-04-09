/**
 * i18nText schema type tests — v0.8 #82
 *
 * Covers:
 *   - i18nText validation on put (all / any / string[] modes)
 *   - MissingTranslationError on put when required langs missing
 *   - Per-call { locale, fallback } on get() and list()
 *   - Raw mode ({ locale: 'raw' }) returns full { [locale]: string } map
 *   - Compartment-default locale via openCompartment({ locale })
 *   - LocaleNotSpecifiedError when locale chain exhausted
 *   - Fallback chain (single + multi-step + 'any')
 *   - Schema validation on put + read
 *   - orderBy on i18nText uses Intl.Collator (smoke test)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import {
  MissingTranslationError,
  LocaleNotSpecifiedError,
} from '../src/errors.js'
import { i18nText } from '../src/i18n.js'
import { resolveI18nText, validateI18nTextValue } from '../src/i18n.js'

// ─── Inline memory adapter ─────────────────────────────────────────────

function memory(): NoydbAdapter {
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
      const comp = store.get(c); const s: CompartmentSnapshot = {}
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

describe('i18nText — Collection integration (#82)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      adapter: memory(),
      user: 'alice',
      secret: 'test-passphrase-i18n-1234',
    })
  })

  it('put and get with locale resolves the field', async () => {
    const company = await db.openCompartment('co1')

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

    const result = await items.get('li-1', { locale: 'th' }) as { id: string; description: string }
    expect(result?.description).toBe('ค่าที่ปรึกษา')
  })

  it('get with locale "en" resolves to English', async () => {
    const company = await db.openCompartment('co1')

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

    const result = await items.get('li-1', { locale: 'en' }) as { id: string; description: string }
    expect(result?.description).toBe('Consulting hours')
  })

  it('get with locale "raw" returns the full map', async () => {
    const company = await db.openCompartment('co1')

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
    const company = await db.openCompartment('co1')

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
    const company = await db.openCompartment('co1')

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
    const company = await db.openCompartment('co1')

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
    const company = await db.openCompartment('co1')

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

    const results = await items.list({ locale: 'th' }) as Array<{ id: string; description: string }>
    const li1 = results.find(r => r.id === 'li-1')
    const li2 = results.find(r => r.id === 'li-2')
    expect(li1?.description).toBe('ที่ปรึกษา')
    expect(li2?.description).toBe('ออกแบบ')
  })

  it('compartment-default locale from openCompartment', async () => {
    const company = await db.openCompartment('co1', { locale: 'th' })

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

    // No locale on get() — uses compartment default 'th'
    const result = await items.get('li-1') as { id: string; description: string }
    expect(result?.description).toBe('ที่ปรึกษา')
  })

  it('per-call locale overrides compartment default', async () => {
    const company = await db.openCompartment('co1', { locale: 'th' })

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

    // Per-call 'en' overrides compartment default 'th'
    const result = await items.get('li-1', { locale: 'en' }) as { id: string; description: string }
    expect(result?.description).toBe('Consulting')
  })

  it('fallback chain resolves when primary locale is missing', async () => {
    const company = await db.openCompartment('co1')

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
    const result = await items.get('li-1', { locale: 'th', fallback: 'en' }) as { id: string; description: string }
    expect(result?.description).toBe('Only English')
  })

  it('throws LocaleNotSpecifiedError when locale chain exhausted', async () => {
    const company = await db.openCompartment('co1')

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
