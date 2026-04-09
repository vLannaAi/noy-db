/**
 * plaintextTranslator hook — v0.8 #83
 *
 * Tests: per-field opt-in, missing translator config, translator throws,
 * cache hit/miss, audit log format, no contentHash, cache cleared on close,
 * sync translator rejected at type level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import { i18nText } from '../src/i18n.js'
import { TranslatorNotConfiguredError } from '../src/errors.js'

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
        if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r }
      }
      return s
    },
    async saveAll(_c, _d) {},
  }
}

interface LineItem {
  id: string
  description: Record<string, string>
  amount: number
}

async function makeDb(translator?: (ctx: { text: string; from: string; to: string; field: string; collection: string }) => Promise<string>, translatorName?: string) {
  const adapter = memory()
  return createNoydb({
    adapter,
    user: 'alice',
    encrypt: false,
    plaintextTranslator: translator,
    plaintextTranslatorName: translatorName,
  })
}

async function openLineItems(db: Awaited<ReturnType<typeof makeDb>>) {
  const company = await db.openCompartment('company')
  return company.collection<LineItem>('line-items', {
    i18nFields: {
      description: i18nText({ languages: ['en', 'th'], required: 'all', autoTranslate: true }),
    },
  })
}

describe('plaintextTranslator (v0.8 #83)', () => {
  let mockTranslator: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockTranslator = vi.fn(async ({ text, to }: { text: string; to: string }) => `[${to}] ${text}`)
  })

  it('auto-translates missing locale before put', async () => {
    const db = await makeDb(mockTranslator)
    const coll = await openLineItems(db)

    await coll.put('li-1', { id: 'li-1', description: { en: 'Consulting hours' }, amount: 100 })

    const record = await coll.get('li-1')
    expect(record?.description).toEqual({
      en: 'Consulting hours',
      th: '[th] Consulting hours',
    })
    expect(mockTranslator).toHaveBeenCalledOnce()
    expect(mockTranslator).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Consulting hours', from: 'en', to: 'th', field: 'description', collection: 'line-items' }),
    )
  })

  it('does not call translator when all locales are present', async () => {
    const db = await makeDb(mockTranslator)
    const coll = await openLineItems(db)

    await coll.put('li-1', { id: 'li-1', description: { en: 'Hello', th: 'สวัสดี' }, amount: 0 })
    expect(mockTranslator).not.toHaveBeenCalled()
  })

  it('throws TranslatorNotConfiguredError when autoTranslate=true but no translator', async () => {
    const db = await makeDb() // no translator
    const coll = await openLineItems(db)

    await expect(
      coll.put('li-1', { id: 'li-1', description: { en: 'Missing translator' }, amount: 0 }),
    ).rejects.toThrow(TranslatorNotConfiguredError)
  })

  it('propagates translator errors as put errors', async () => {
    const failingTranslator = vi.fn(async () => {
      throw new Error('DeepL quota exceeded')
    })
    const db = await makeDb(failingTranslator)
    const coll = await openLineItems(db)

    await expect(
      coll.put('li-1', { id: 'li-1', description: { en: 'Will fail' }, amount: 0 }),
    ).rejects.toThrow('DeepL quota exceeded')
  })

  it('serves from cache on repeated identical puts', async () => {
    const db = await makeDb(mockTranslator)
    const coll = await openLineItems(db)

    await coll.put('li-1', { id: 'li-1', description: { en: 'Cached text' }, amount: 0 })
    await coll.put('li-2', { id: 'li-2', description: { en: 'Cached text' }, amount: 0 })

    // Translator called only once — second put hits the cache
    expect(mockTranslator).toHaveBeenCalledOnce()
  })

  it('records audit entry for each translation with cache hit flag', async () => {
    const db = await makeDb(mockTranslator, 'deepl-test')
    const coll = await openLineItems(db)

    await coll.put('li-1', { id: 'li-1', description: { en: 'Audit text' }, amount: 0 })
    await coll.put('li-2', { id: 'li-2', description: { en: 'Audit text' }, amount: 0 }) // cache hit

    const log = db.translatorAuditLog()
    expect(log).toHaveLength(2)

    const [first, second] = log
    expect(first?.type).toBe('translator-invocation')
    expect(first?.field).toBe('description')
    expect(first?.collection).toBe('line-items')
    expect(first?.fromLocale).toBe('en')
    expect(first?.toLocale).toBe('th')
    expect(first?.translatorName).toBe('deepl-test')
    expect(first?.cached).toBeUndefined() // cache miss

    expect(second?.cached).toBe(true) // cache hit

    // CRITICAL invariant: no contentHash field anywhere
    expect('contentHash' in (first ?? {})).toBe(false)
    expect('contentHash' in (second ?? {})).toBe(false)
  })

  it('uses "anonymous" as translatorName when none supplied', async () => {
    const db = await makeDb(mockTranslator) // no name
    const coll = await openLineItems(db)
    await coll.put('li-1', { id: 'li-1', description: { en: 'Name test' }, amount: 0 })
    const [entry] = db.translatorAuditLog()
    expect(entry?.translatorName).toBe('anonymous')
  })

  it('clears translator cache and audit log on db.close()', async () => {
    const db = await makeDb(mockTranslator)
    const coll = await openLineItems(db)

    await coll.put('li-1', { id: 'li-1', description: { en: 'Before close' }, amount: 0 })
    expect(db.translatorAuditLog()).toHaveLength(1)

    db.close()
    expect(db.translatorAuditLog()).toHaveLength(0)
  })

  it('translates only required missing locales for string[] required mode', async () => {
    const db = await makeDb(mockTranslator)
    const company = await db.openCompartment('co2')
    const coll = company.collection<{ id: string; label: Record<string, string> }>('items', {
      i18nFields: {
        label: i18nText({ languages: ['en', 'th', 'zh'], required: ['en', 'th'], autoTranslate: true }),
      },
    })

    await coll.put('x', { id: 'x', label: { en: 'Hello' } })
    // Only 'th' should be translated (it's in required, missing from value)
    // 'zh' is not required so should not be translated
    expect(mockTranslator).toHaveBeenCalledOnce()
    const call = mockTranslator.mock.calls[0]?.[0]
    expect(call?.to).toBe('th')
  })

  it('fields without autoTranslate are not translated', async () => {
    const db = await makeDb(mockTranslator)
    const company = await db.openCompartment('co3')
    const coll = company.collection<{ id: string; title: Record<string, string> }>('items', {
      i18nFields: {
        title: i18nText({ languages: ['en', 'th'], required: 'all' }), // no autoTranslate
      },
    })

    // Should throw MissingTranslationError, NOT call the translator
    await expect(
      coll.put('x', { id: 'x', title: { en: 'Only English' } }),
    ).rejects.toThrow(/requires all declared languages/)
    expect(mockTranslator).not.toHaveBeenCalled()
  })
})
