/**
 * Pod (bundle) header round-trip + minimum-disclosure regression for
 * the cover. The header's JSON key keeps its frozen wire name
 * `publicEnvelope` (#799 renamed only the developer surface).
 *
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md
 */
import { describe, it, expect } from 'vitest'
import {
  encodeBundleHeader,
  decodeBundleHeader,
  validateBundleHeader,
  NOYDB_BUNDLE_FORMAT_VERSION,
} from '../src/with-pod/format.js'
import type { NoydbBundleHeader } from '../src/with-pod/format.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createNoydb } from '../src/kernel/noydb.js'
import {
  writeNoydbBundle,
  readNoydbBundle,
  readNoydbBundleHeader,
  readPodCover,
} from '../src/with-pod/bundle.js'

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

const HANDLE = '01HZZZZZZZZZZZZZZZZZZZZZZZ'
const BODY_HASH = '0'.repeat(64)
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('bundle header — minimum-disclosure regression', () => {
  it('still rejects unknown keys (the rule survives the publicEnvelope addition)', () => {
    expect(() =>
      validateBundleHeader({
        formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
        handle: HANDLE,
        bodyBytes: 100,
        bodySha256: BODY_HASH,
        forbidden: 'leak',
      }),
    ).toThrow(/forbidden key "forbidden"/)
  })

  it('still rejects renamed forbidden keys (e.g. vault, exporter)', () => {
    expect(() =>
      validateBundleHeader({
        formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
        handle: HANDLE,
        bodyBytes: 100,
        bodySha256: BODY_HASH,
        vault: 'Acme Corp',
      }),
    ).toThrow(/forbidden key "vault"/)
  })
})

describe('bundle header — publicEnvelope shape', () => {
  it('round-trips a minimal envelope through encode/decode', () => {
    const header: NoydbBundleHeader = {
      formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
      handle: HANDLE,
      bodyBytes: 100,
      bodySha256: BODY_HASH,
      publicEnvelope: { _noydb_public: 1, version: 1, name: 'Acme' },
    }
    const bytes = encodeBundleHeader(header)
    const back = decodeBundleHeader(bytes)
    expect(back.publicEnvelope).toEqual({ _noydb_public: 1, version: 1, name: 'Acme' })
  })

  it('round-trips a locale-map envelope', () => {
    const header: NoydbBundleHeader = {
      formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
      handle: HANDLE,
      bodyBytes: 100,
      bodySha256: BODY_HASH,
      publicEnvelope: {
        _noydb_public: 1,
        version: 2,
        name: { en: 'Acme', th: 'อะคมี' },
        defaultLocale: 'en',
        icon: TINY_PNG,
      },
    }
    const bytes = encodeBundleHeader(header)
    const back = decodeBundleHeader(bytes)
    expect((back.publicEnvelope!.name as Record<string, string>).th).toBe('อะคมี')
  })

  it('omits the field when absent (back-compat — old bundles still parse)', () => {
    const header: NoydbBundleHeader = {
      formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
      handle: HANDLE,
      bodyBytes: 100,
      bodySha256: BODY_HASH,
    }
    const bytes = encodeBundleHeader(header)
    const back = decodeBundleHeader(bytes)
    expect(back.publicEnvelope).toBeUndefined()
    // Forward compat: a JSON header with the key absent decodes too.
    const json = new TextDecoder().decode(bytes)
    expect(json).not.toContain('publicEnvelope')
  })

  it('rejects a publicEnvelope with the wrong _noydb_public marker', () => {
    expect(() =>
      validateBundleHeader({
        formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
        handle: HANDLE,
        bodyBytes: 100,
        bodySha256: BODY_HASH,
        publicEnvelope: { _noydb_public: 2, version: 1 },
      }),
    ).toThrow(/_noydb_public/)
  })

  it('rejects a publicEnvelope with no version', () => {
    expect(() =>
      validateBundleHeader({
        formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
        handle: HANDLE,
        bodyBytes: 100,
        bodySha256: BODY_HASH,
        publicEnvelope: { _noydb_public: 1 },
      }),
    ).toThrow(/version/)
  })

  it('rejects a non-object publicEnvelope', () => {
    expect(() =>
      validateBundleHeader({
        formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
        handle: HANDLE,
        bodyBytes: 100,
        bodySha256: BODY_HASH,
        publicEnvelope: 'oops',
      }),
    ).toThrow(/must be a JSON object/)
  })
})

describe('writeNoydbBundle / readPodCover round-trip', () => {
  it('snapshots the vault\'s cover into the bundle header', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
      cover: true,
    })
    const vault = await db.openVault('acme')
    await db.setCover('acme', {
      name: 'Acme 2026 Tax Records',
      icon: TINY_PNG,
    })

    const bundleBytes = await writeNoydbBundle(vault)
    const env = readPodCover(bundleBytes)
    expect(env?.name).toBe('Acme 2026 Tax Records')
    expect(env?.icon).toBe(TINY_PNG)

    // Header read also surfaces it
    const header = readNoydbBundleHeader(bundleBytes)
    expect(header.publicEnvelope?.name).toBe('Acme 2026 Tax Records')
  }, 60_000)

  it('locale-resolves on the readPodCover path', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
      cover: true,
    })
    const vault = await db.openVault('acme')
    await db.setCover('acme', {
      name: { en: 'Acme 2026', th: 'อะคมี 2026' },
      defaultLocale: 'en',
    })
    const bundleBytes = await writeNoydbBundle(vault)
    const th = readPodCover(bundleBytes, { locale: 'th' })
    expect(th?.name).toBe('อะคมี 2026')

    const fallback = readPodCover(bundleBytes, { locale: 'de' })
    expect(fallback?.name).toBe('Acme 2026') // defaultLocale = 'en'
  }, 60_000)

  it('returns undefined when the source vault has no cover', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
      cover: true,
    })
    const vault = await db.openVault('acme')
    const bundleBytes = await writeNoydbBundle(vault)
    expect(readPodCover(bundleBytes)).toBeUndefined()
  }, 60_000)

  it('receiver-side reattachment pattern — header carries cover, owner re-attaches via setCover', async () => {
    // Use the same credentials throughout — `vault.load` rebuilds the
    // keyring set from the bundle, so a fresh-user destination would
    // need Alice's secret to unlock the restored vault. The point
    // of this test is the *envelope reattachment pattern*, not the
    // multi-user-transfer story.
    const SECRET = 'correct horse battery staple printer toaster'

    // Source — has a cover persisted.
    const sourceStore = inlineMemory()
    const source = await createNoydb({
      store: sourceStore,
      user: 'alice',
      secret: SECRET,
      cover: true,
    })
    const sourceVault = await source.openVault('acme')
    await source.setCover('acme', { name: 'Acme 2026 Tax Records' })
    const bundleBytes = await writeNoydbBundle(sourceVault)

    // Destination — different store, different vault name.
    const destStore = inlineMemory()
    const dest = await createNoydb({
      store: destStore,
      user: 'alice',
      secret: SECRET,
      cover: true,
    })
    const destVault = await dest.openVault('acme-restored')

    // Header read first — surfaces the cover without unlocking.
    const result = await readNoydbBundle(bundleBytes)
    expect(result.header.publicEnvelope?.name).toBe('Acme 2026 Tax Records')

    // vault.load — whether _meta/* survives is store-dependent
    // (some stores filter underscore-prefixed collections in
    // loadAll). The reattachment pattern is the safe portable
    // approach: read the cover from the bundle header, set it
    // explicitly on the destination.
    await destVault.load(result.dumpJson)

    if (result.header.publicEnvelope) {
      const env = result.header.publicEnvelope
      await dest.setCover('acme-restored', {
        ...(env.name !== undefined ? { name: env.name } : {}),
      })
    }

    expect((await dest.getCover('acme-restored'))?.name).toBe('Acme 2026 Tax Records')
  }, 60_000)

  it('the body still round-trips through readNoydbBundle (cover does not break decryption)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct horse battery staple printer toaster',
      cover: true,
    })
    const vault = await db.openVault('acme')
    await db.setCover('acme', { name: 'Acme' })
    const bundleBytes = await writeNoydbBundle(vault)

    // Verify the body's integrity hash matches; this also exercises
    // the entire bundle decode path with the new header field present.
    const result = await readNoydbBundle(bundleBytes)
    expect(result.header.publicEnvelope?.name).toBe('Acme')
    expect(typeof result.dumpJson).toBe('string')
  }, 60_000)
})
