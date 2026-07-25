/**
 * Cover `custom` slot (#800) — namespaced integrator extension slot
 * plus the total-size caps (`maxCustomBytes`, `maxCoverBytes`).
 * Covers: namespace-level patch semantics, schema gating (opt-in,
 * excluded from defaults), key-pattern + JSON-value validation, the
 * locale-map-bomb regression for the whole-document cap, and the
 * additive wire path (pod header round-trip, old-reader tolerance).
 *
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { ValidationError } from '../src/kernel/errors.js'
import {
  resolveSchema,
  validateCoverInput,
  isCover,
  mergeCustom,
  validateCoverSize,
  resolveLocale,
  COVER_FIELDS,
  DEFAULT_COVER_SCHEMA,
  type Cover,
  type JsonValue,
} from '../src/with-party/directory/cover/index.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { writeNoydbBundle, readPodCover } from '../src/with-pod/bundle.js'

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
    async loadAll(c) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      const comp = store.get(c) ?? new Map()
      for (const [col, recs] of comp) {
        out[col] = Object.fromEntries(recs)
      }
      return out
    },
    async saveAll(c, data: Record<string, Record<string, EncryptedEnvelope>>) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [col, recs] of Object.entries(data)) {
        comp.set(col, new Map(Object.entries(recs)))
      }
      store.set(c, comp)
    },
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

const SECRET = 'correct horse battery staple printer toaster'

/** Schema enabling the display fields AND the opt-in custom slot. */
const CUSTOM_ENABLED = {
  fields: ['name', 'description', 'icon', 'defaultLocale', 'custom'],
} as const

async function customDb(store: NoydbStore, coverOverrides: object = {}) {
  return createNoydb({
    store,
    user: 'alice',
    secret: SECRET,
    cover: { ...CUSTOM_ENABLED, ...coverOverrides },
  })
}

/** `n` nested object levels around a string leaf. */
function nest(n: number): JsonValue {
  return n === 0 ? 'leaf' : { child: nest(n - 1) }
}

describe('schema defaults — custom is opt-in', () => {
  it("COVER_FIELDS contains 'custom' but DEFAULT_COVER_SCHEMA.fields does not", () => {
    expect(COVER_FIELDS).toContain('custom')
    expect(DEFAULT_COVER_SCHEMA.fields).not.toContain('custom')
    expect(DEFAULT_COVER_SCHEMA.fields).toEqual([
      'name', 'description', 'icon', 'createdAt', 'updatedAt', 'defaultLocale',
    ])
  })

  it('resolveSchema(true) excludes custom and carries the default caps', () => {
    const r = resolveSchema(true)!
    expect(r.fields).not.toContain('custom')
    expect(r.maxCustomBytes).toBe(8 * 1024)
    expect(r.maxCoverBytes).toBe(300 * 1024)
  })

  it('cap overrides merge onto defaults', () => {
    const r = resolveSchema({ maxCustomBytes: 64, maxCoverBytes: 1024 })!
    expect(r.maxCustomBytes).toBe(64)
    expect(r.maxCoverBytes).toBe(1024)
    expect(r.maxIconBytes).toBe(256 * 1024)
  })
})

describe('validateCoverInput — custom gating + key pattern + values', () => {
  const enabled = resolveSchema(CUSTOM_ENABLED)!
  const defaults = resolveSchema(true)!

  it('rejects custom when the schema does not enable it (default field set)', () => {
    expect(() =>
      validateCoverInput({ custom: { 'noydb.viewer': { theme: 'dark' } } }, defaults),
    ).toThrow(ValidationError)
  })

  it('accepts custom when the schema lists it explicitly', () => {
    expect(() =>
      validateCoverInput({ custom: { 'noydb.viewer': { theme: 'dark' } } }, enabled),
    ).not.toThrow()
  })

  it('accepts dotted, reverse-DNS and dashed namespace keys', () => {
    for (const key of ['noydb.viewer', 'com.acme.registry', 'acme-viewer']) {
      expect(() =>
        validateCoverInput({ custom: { [key]: { ok: true } } }, enabled),
      ).not.toThrow()
    }
  })

  it('rejects bare-word, empty and whitespace namespace keys', () => {
    for (const key of ['config', '', 'has space', 'noydb.']) {
      expect(() =>
        validateCoverInput({ custom: { [key]: { ok: true } } }, enabled),
      ).toThrow(ValidationError)
    }
  })

  it('the key-pattern error names the offending key', () => {
    expect(() =>
      validateCoverInput({ custom: { config: 1 } }, enabled),
    ).toThrow(/"config"/)
  })

  it('rejects a non-object custom value', () => {
    expect(() =>
      validateCoverInput({ custom: ['nope'] as never }, enabled),
    ).toThrow(ValidationError)
  })

  it('accepts nesting at the depth cap (8), rejects depth 9', () => {
    expect(() =>
      validateCoverInput({ custom: { 'noydb.viewer': nest(8) } }, enabled),
    ).not.toThrow()
    expect(() =>
      validateCoverInput({ custom: { 'noydb.viewer': nest(9) } }, enabled),
    ).toThrow(/noydb\.viewer/)
  })

  it('rejects a circular reference', () => {
    const a: Record<string, unknown> = { x: 1 }
    a['self'] = a
    expect(() =>
      validateCoverInput({ custom: { 'noydb.viewer': a as never } }, enabled),
    ).toThrow(/noydb\.viewer/)
  })

  it('rejects undefined inside an object', () => {
    expect(() =>
      validateCoverInput(
        { custom: { 'noydb.viewer': { theme: undefined } as never } },
        enabled,
      ),
    ).toThrow(ValidationError)
  })

  it('rejects bigint and function values', () => {
    expect(() =>
      validateCoverInput({ custom: { 'noydb.viewer': { n: 10n } as never } }, enabled),
    ).toThrow(ValidationError)
    expect(() =>
      validateCoverInput({ custom: { 'noydb.viewer': (() => 1) as never } }, enabled),
    ).toThrow(ValidationError)
  })

  it('accepts null as a namespace value (the delete directive)', () => {
    expect(() =>
      validateCoverInput({ custom: { 'noydb.viewer': null } }, enabled),
    ).not.toThrow()
  })
})

describe('mergeCustom — namespace-level patch', () => {
  it('returns {} when neither side has custom', () => {
    expect(mergeCustom(undefined, undefined)).toEqual({})
  })

  it('preserves existing custom when the patch is absent', () => {
    expect(mergeCustom({ 'noydb.viewer': { theme: 'dark' } }, undefined))
      .toEqual({ custom: { 'noydb.viewer': { theme: 'dark' } } })
  })

  it('replaces provided namespaces, preserves absent ones', () => {
    const merged = mergeCustom(
      { 'noydb.viewer': { theme: 'dark' }, 'com.acme.registry': { tenant: 'eu' } },
      { 'noydb.viewer': { theme: 'light' } },
    )
    expect(merged).toEqual({
      custom: {
        'noydb.viewer': { theme: 'light' },
        'com.acme.registry': { tenant: 'eu' },
      },
    })
  })

  it('null deletes a namespace and never persists', () => {
    const merged = mergeCustom(
      { 'noydb.viewer': { theme: 'dark' }, 'com.acme.registry': { tenant: 'eu' } },
      { 'noydb.viewer': null },
    )
    expect(merged).toEqual({ custom: { 'com.acme.registry': { tenant: 'eu' } } })
  })

  it('deleting the last namespace drops the custom field entirely', () => {
    expect(mergeCustom({ 'noydb.viewer': { theme: 'dark' } }, { 'noydb.viewer': null }))
      .toEqual({})
    expect(mergeCustom(undefined, { 'noydb.viewer': null })).toEqual({})
  })
})

describe('validateCoverSize — post-merge caps', () => {
  it('rejects an oversized custom object with actual vs cap in the message', () => {
    const schema = resolveSchema({ ...CUSTOM_ENABLED, maxCustomBytes: 64 })!
    const cover: Cover = {
      _noydb_public: 1,
      version: 1,
      custom: { 'noydb.viewer': { padding: 'x'.repeat(64) } },
    }
    const size = JSON.stringify(cover.custom).length
    expect(() => validateCoverSize(cover, schema))
      .toThrow(new RegExp(`64-byte.*${size}`))
  })

  it('rejects a cover document over maxCoverBytes with actual vs cap in the message', () => {
    const schema = resolveSchema({ maxCoverBytes: 128 })!
    const cover: Cover = {
      _noydb_public: 1,
      version: 1,
      name: 'n'.repeat(150),
    }
    const size = JSON.stringify(cover).length
    expect(() => validateCoverSize(cover, schema))
      .toThrow(new RegExp(`128-byte.*${size}`))
  })

  it('accepts a document within both caps', () => {
    const schema = resolveSchema(CUSTOM_ENABLED)!
    const cover: Cover = {
      _noydb_public: 1,
      version: 1,
      name: 'Acme',
      custom: { 'noydb.viewer': { theme: 'dark' } },
    }
    expect(() => validateCoverSize(cover, schema)).not.toThrow()
  })
})

describe('Noydb integration — custom patch semantics', () => {
  it('replace-provided / preserve-absent across writes', async () => {
    const db = await customDb(inlineMemory())
    await db.openVault('acme')
    await db.setCover('acme', {
      name: 'Acme 2026',
      custom: {
        'noydb.viewer': { theme: 'dark' },
        'com.acme.registry': { tenant: 'eu-west' },
      },
    })
    const second = await db.setCover('acme', {
      custom: { 'noydb.viewer': { theme: 'light', defaultCollection: 'invoices' } },
    })
    expect(second.custom).toEqual({
      'noydb.viewer': { theme: 'light', defaultCollection: 'invoices' },
      'com.acme.registry': { tenant: 'eu-west' },
    })
    expect(second.name).toBe('Acme 2026') // display fields also preserved
  })

  it('null deletes a namespace; deleting the last one drops custom', async () => {
    const db = await customDb(inlineMemory())
    await db.openVault('acme')
    await db.setCover('acme', {
      custom: {
        'noydb.viewer': { theme: 'dark' },
        'com.acme.registry': { tenant: 'eu-west' },
      },
    })
    const afterDelete = await db.setCover('acme', {
      custom: { 'com.acme.registry': null },
    })
    expect(afterDelete.custom).toEqual({ 'noydb.viewer': { theme: 'dark' } })
    expect(afterDelete.custom).not.toHaveProperty('com.acme.registry')

    const empty = await db.setCover('acme', { custom: { 'noydb.viewer': null } })
    expect(empty.custom).toBeUndefined()
  })

  it('null on a fresh cover never persists as a namespace value', async () => {
    const db = await customDb(inlineMemory())
    await db.openVault('acme')
    const written = await db.setCover('acme', {
      name: 'Acme',
      custom: { 'noydb.viewer': null },
    })
    expect(written.custom).toBeUndefined()
    const read = await db.getCover('acme')
    expect(read?.custom).toBeUndefined()
  })

  it('a write without custom preserves the previous custom', async () => {
    const db = await customDb(inlineMemory())
    await db.openVault('acme')
    await db.setCover('acme', { custom: { 'noydb.viewer': { theme: 'dark' } } })
    const second = await db.setCover('acme', { name: 'Acme v2' })
    expect(second.custom).toEqual({ 'noydb.viewer': { theme: 'dark' } })
  })

  it('version bumps, createdAt is preserved, updatedAt refreshes on custom-only writes', async () => {
    const db = await customDb(inlineMemory())
    await db.openVault('acme')
    const first = await db.setCover('acme', { custom: { 'noydb.viewer': { v: 1 } } })
    await new Promise((r) => setTimeout(r, 5))
    const second = await db.setCover('acme', { custom: { 'noydb.viewer': { v: 2 } } })
    expect(second.version).toBe(first.version + 1)
    expect(second.createdAt).toBe(first.createdAt)
    expect(Date.parse(second.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt!))
  })

  it('cover: true shorthand rejects custom (opt-in only)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: SECRET, cover: true })
    await db.openVault('acme')
    await expect(
      db.setCover('acme', { custom: { 'noydb.viewer': { theme: 'dark' } } }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('Noydb integration — size caps', () => {
  it('rejects an oversized custom write (maxCustomBytes)', async () => {
    const db = await customDb(inlineMemory(), { maxCustomBytes: 64 })
    await db.openVault('acme')
    await expect(
      db.setCover('acme', { custom: { 'noydb.viewer': { pad: 'x'.repeat(100) } } }),
    ).rejects.toThrow(/64-byte/)
  })

  it('a small patch that tips the MERGED custom over the cap is rejected', async () => {
    const db = await customDb(inlineMemory(), { maxCustomBytes: 100 })
    await db.openVault('acme')
    await db.setCover('acme', { custom: { 'noydb.viewer': { pad: 'x'.repeat(40) } } })
    // Alone this namespace fits; merged with the existing one it doesn't.
    await expect(
      db.setCover('acme', { custom: { 'com.acme.registry': { pad: 'y'.repeat(40) } } }),
    ).rejects.toThrow(/100-byte/)
    // Replacing the existing namespace with a smaller value still works.
    const ok = await db.setCover('acme', { custom: { 'noydb.viewer': { pad: 'z' } } })
    expect(ok.custom).toEqual({ 'noydb.viewer': { pad: 'z' } })
  })

  it('locale-map bomb regression — a name map with thousands of keys is rejected by maxCoverBytes', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: SECRET, cover: true })
    await db.openVault('acme')
    // 2 000 locale keys × 200-char values: every VALUE is within
    // maxStringChars, but the serialized document is ~430 KB — over
    // the 300 KB whole-document default cap.
    const bomb = Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => [
        `x-${String(i).padStart(4, '0')}`,
        'a'.repeat(200),
      ]),
    )
    await expect(db.setCover('acme', { name: bomb })).rejects.toThrow(/307200-byte/)
  })
})

describe('wire — additive, no format bump', () => {
  it('a cover with custom round-trips through the pod header (writePod → readPodCover)', async () => {
    const store = inlineMemory()
    const db = await customDb(store)
    const vault = await db.openVault('acme')
    await db.setCover('acme', {
      name: { en: 'Acme 2026', th: 'อะคมี 2026' },
      defaultLocale: 'en',
      custom: { 'noydb.viewer': { defaultCollection: 'invoices', theme: 'dark' } },
    })
    const bundleBytes = await writeNoydbBundle(vault)
    const env = readPodCover(bundleBytes)
    expect(env?.custom).toEqual({
      'noydb.viewer': { defaultCollection: 'invoices', theme: 'dark' },
    })
    // Locale resolution keeps custom intact.
    const th = readPodCover(bundleBytes, { locale: 'th' })
    expect(th?.name).toBe('อะคมี 2026')
    expect(th?.custom).toEqual({
      'noydb.viewer': { defaultCollection: 'invoices', theme: 'dark' },
    })
  }, 60_000)

  it('old-reader path — isCover still recognises a document carrying custom', async () => {
    const store = inlineMemory()
    const db = await customDb(store)
    await db.openVault('acme')
    await db.setCover('acme', { custom: { 'noydb.viewer': { theme: 'dark' } } })
    const envelope = await store.get('acme', '_meta', 'public-envelope')
    const parsed = JSON.parse(envelope!._data) as unknown
    expect(isCover(parsed)).toBe(true)
    expect((parsed as Cover).custom).toEqual({ 'noydb.viewer': { theme: 'dark' } })
  })

  it('resolveLocale passes custom through untouched', () => {
    const cover: Cover = {
      _noydb_public: 1,
      version: 1,
      name: { en: 'Acme', th: 'อะคมี' },
      defaultLocale: 'en',
      custom: { 'noydb.viewer': { theme: 'dark' } },
    }
    const resolved = resolveLocale(cover, 'th')
    expect(resolved.name).toBe('อะคมี')
    expect(resolved.custom).toEqual({ 'noydb.viewer': { theme: 'dark' } })
  })

  it('getCover with a locale keeps custom', async () => {
    const db = await customDb(inlineMemory())
    await db.openVault('acme')
    await db.setCover('acme', {
      name: { en: 'Acme', th: 'อะคมี' },
      defaultLocale: 'en',
      custom: { 'noydb.viewer': { theme: 'dark' } },
    })
    const th = await db.getCover('acme', { locale: 'th' })
    expect(th?.name).toBe('อะคมี')
    expect(th?.custom).toEqual({ 'noydb.viewer': { theme: 'dark' } })
  })
})
