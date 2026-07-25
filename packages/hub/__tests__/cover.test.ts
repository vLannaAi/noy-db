/**
 * Cover service — schema validation, storage round-trip, locale
 * resolution, disabled-feature negative path. (Formerly "public
 * envelope" — the wire keeps that name: `_meta/public-envelope`.)
 *
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { ValidationError } from '../src/kernel/errors.js'
import {
  loadCover,
  saveCover,
  readCover,
  resolveSchema,
  validateCoverInput,
  isCover,
  COVER_FIELDS,
  type Cover,
} from '../src/with-party/directory/cover/index.js'
import { createNoydb } from '../src/kernel/noydb.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'inline-memory',
    async get(c, col, id) { return gc(c, col).get(id) },
    async put(c, col, id, env) { gc(c, col).set(id, env) },
    async delete(c, col, id) { gc(c, col).delete(id) },
    async list(c, col) { return [...gc(c, col).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('resolveSchema', () => {
  it('returns undefined when feature is disabled (undefined / false)', () => {
    expect(resolveSchema(undefined)).toBeUndefined()
  })

  it('returns full defaults for shorthand `true`', () => {
    const r = resolveSchema(true)!
    // #800: the default field set is the six display fields — the
    // opt-in 'custom' slot is in COVER_FIELDS but NOT the defaults.
    expect(r.fields).toEqual(COVER_FIELDS.filter((f) => f !== 'custom'))
    expect(r.maxIconBytes).toBe(256 * 1024)
    expect(r.iconMimeTypes).toEqual(['image/png', 'image/svg+xml'])
    expect(r.maxStringChars).toBe(200)
    expect(r.maxCustomBytes).toBe(8 * 1024)
    expect(r.maxCoverBytes).toBe(300 * 1024)
  })

  it('merges partial overrides onto defaults', () => {
    const r = resolveSchema({ fields: ['name', 'icon'], maxIconBytes: 1024 })!
    expect(r.fields).toEqual(['name', 'icon'])
    expect(r.maxIconBytes).toBe(1024)
    expect(r.iconMimeTypes).toEqual(['image/png', 'image/svg+xml'])
    expect(r.maxStringChars).toBe(200)
  })
})

describe('validateCoverInput', () => {
  const schema = resolveSchema(true)!

  it('accepts a well-formed string name', () => {
    expect(() => validateCoverInput({ name: 'Acme' }, schema)).not.toThrow()
  })

  it('accepts a locale-map name', () => {
    expect(() =>
      validateCoverInput({ name: { en: 'Acme', th: 'อะคมี' } }, schema),
    ).not.toThrow()
  })

  it('rejects an unknown field', () => {
    expect(() =>
      validateCoverInput({ stranger: 'value' } as never, schema),
    ).toThrow(ValidationError)
  })

  it('rejects a field not enabled by the schema', () => {
    const narrow = resolveSchema({ fields: ['name'] })!
    expect(() => validateCoverInput({ icon: TINY_PNG }, narrow)).toThrow(ValidationError)
  })

  it('rejects an oversize string', () => {
    const huge = 'a'.repeat(201)
    expect(() => validateCoverInput({ name: huge }, schema)).toThrow(/200-character/)
  })

  it('rejects an oversize string inside a locale map', () => {
    const huge = 'a'.repeat(201)
    expect(() =>
      validateCoverInput({ name: { en: huge } }, schema),
    ).toThrow(/200-character/)
  })

  it('rejects a non-data-URL icon', () => {
    expect(() =>
      validateCoverInput({ icon: 'https://example.com/icon.png' }, schema),
    ).toThrow(/data URL|External URLs/)
  })

  it('rejects a disallowed MIME type', () => {
    const jpeg = 'data:image/jpeg;base64,/9j/AA=='
    expect(() => validateCoverInput({ icon: jpeg }, schema)).toThrow(/MIME/)
  })

  it('rejects an icon larger than the cap', () => {
    const tiny = resolveSchema({ maxIconBytes: 100 })!
    expect(() =>
      validateCoverInput({ icon: TINY_PNG }, tiny),
    ).toThrow(/byte cap/)
  })

  it('accepts an icon at exactly the cap', () => {
    const fits = resolveSchema({ maxIconBytes: TINY_PNG.length })!
    expect(() =>
      validateCoverInput({ icon: TINY_PNG }, fits),
    ).not.toThrow()
  })
})

describe('isCover', () => {
  it('recognises a well-formed cover', () => {
    expect(isCover({ _noydb_public: 1, version: 1 })).toBe(true)
  })

  it('rejects shape impostors', () => {
    expect(isCover({ _noydb_public: 2, version: 1 })).toBe(false)
    expect(isCover({ _noydb_public: 1, version: 'one' })).toBe(false)
    expect(isCover(null)).toBe(false)
    expect(isCover([])).toBe(false)
    expect(isCover('string')).toBe(false)
  })
})

describe('storage round-trip', () => {
  it('save → load returns the same shape', async () => {
    const store = inlineMemory()
    const env: Cover = {
      _noydb_public: 1,
      version: 1,
      name: 'Acme 2026',
      icon: TINY_PNG,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await saveCover(store, 'acme', env)
    const loaded = await loadCover(store, 'acme')
    expect(loaded).toEqual(env)
  })

  it('returns undefined when no cover is on disk', async () => {
    const store = inlineMemory()
    expect(await loadCover(store, 'never-saved')).toBeUndefined()
  })

  it('returns undefined on a corrupted document (does not throw)', async () => {
    const store = inlineMemory()
    await store.put('acme', '_meta', 'public-envelope', {
      _noydb: 1,
      _v: 1,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: 'not json{',
    })
    expect(await loadCover(store, 'acme')).toBeUndefined()
  })

  it('returns undefined on a shape-mismatch document', async () => {
    const store = inlineMemory()
    await store.put('acme', '_meta', 'public-envelope', {
      _noydb: 1,
      _v: 1,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: JSON.stringify({ _noydb_public: 2, version: 1 }),
    })
    expect(await loadCover(store, 'acme')).toBeUndefined()
  })
})

describe('readCover locale resolution', () => {
  async function withLocaleMapCover() {
    const store = inlineMemory()
    await saveCover(store, 'acme', {
      _noydb_public: 1,
      version: 1,
      name: { en: 'Acme 2026', th: 'อะคมี 2026' },
      description: { en: 'Q1-Q4 invoices', th: 'ใบแจ้งหนี้ Q1-Q4' },
      defaultLocale: 'en',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    return store
  }

  it('returns the raw map when locale is omitted', async () => {
    const store = await withLocaleMapCover()
    const r = (await readCover(store, 'acme'))!
    expect(typeof r.name).toBe('object')
    expect((r.name as Record<string, string>).en).toBe('Acme 2026')
  })

  it('resolves to the requested locale', async () => {
    const store = await withLocaleMapCover()
    const r = (await readCover(store, 'acme', { locale: 'th' }))!
    expect(r.name).toBe('อะคมี 2026')
    expect(r.description).toBe('ใบแจ้งหนี้ Q1-Q4')
  })

  it('falls back to defaultLocale when the requested locale is missing', async () => {
    const store = await withLocaleMapCover()
    const r = (await readCover(store, 'acme', { locale: 'de' }))!
    expect(r.name).toBe('Acme 2026') // defaultLocale = 'en'
  })

  it('passes single-string fields through unchanged', async () => {
    const store = inlineMemory()
    await saveCover(store, 'acme', {
      _noydb_public: 1,
      version: 1,
      name: 'Acme 2026',
      defaultLocale: 'en',
    })
    const r = (await readCover(store, 'acme', { locale: 'th' }))!
    expect(r.name).toBe('Acme 2026')
  })
})

describe('Noydb integration — disabled feature', () => {
  it('throws ValidationError when setCover is called without enabling the feature', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
    })
    await db.openVault('acme')
    await expect(
      db.setCover('acme', { name: 'Acme' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('getCover returns undefined for vaults with no cover', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
    })
    await db.openVault('acme')
    expect(await db.getCover('acme')).toBeUndefined()
  })
})

describe('Noydb integration — enabled feature', () => {
  it('setCover persists, getCover reads it back', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
      cover: true,
    })
    await db.openVault('acme')
    const written = await db.setCover('acme', {
      name: 'Acme 2026',
      description: 'Q1-Q4 invoices',
      icon: TINY_PNG,
    })
    expect(written.version).toBe(1)
    expect(written.createdAt).toBeDefined()

    const read = await db.getCover('acme')
    expect(read?.name).toBe('Acme 2026')
    expect(read?.icon).toBe(TINY_PNG)
  })

  it('preserves createdAt across writes; bumps version + updatedAt', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
      cover: true,
    })
    await db.openVault('acme')
    const first = await db.setCover('acme', { name: 'Acme 2026' })
    await new Promise((r) => setTimeout(r, 5))
    const second = await db.setCover('acme', { name: 'Acme 2026 v2' })
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.version).toBe(first.version + 1)
    expect(Date.parse(second.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt!))
  })

  it('reading via Noydb honours the locale option', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
      cover: true,
    })
    await db.openVault('acme')
    await db.setCover('acme', {
      name: { en: 'Acme 2026', th: 'อะคมี 2026' },
      defaultLocale: 'en',
    })
    const th = await db.getCover('acme', { locale: 'th' })
    expect(th?.name).toBe('อะคมี 2026')
    const raw = await db.getCover('acme')
    expect(typeof raw?.name).toBe('object')
  })

  it('narrow schema rejects fields outside the allowlist', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
      cover: { fields: ['name'] },
    })
    await db.openVault('acme')
    await expect(
      db.setCover('acme', { name: 'OK', icon: TINY_PNG }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
