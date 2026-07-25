/**
 * #799 public-envelope → cover rename — the deprecated aliases must
 * keep working for one pre-release window: every old export name is
 * the same runtime value as its new canonical name, the old
 * `Noydb`/`Vault` methods delegate to the new ones, and both
 * `NoydbOptions` keys (`cover` / deprecated `publicEnvelope`) are
 * accepted, with `cover` winning when both are set.
 *
 * Delete this file together with the aliases after the window closes.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { ValidationError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import {
  // canonical
  loadCover,
  saveCover,
  readCover,
  resolveCoverSchema,
  validateCoverInput,
  isCover,
  COVER_FIELDS,
  DEFAULT_COVER_SCHEMA,
  COVER_RECORD_ID,
  readPodCover,
  // deprecated aliases
  loadPublicEnvelope,
  savePublicEnvelope,
  readPublicEnvelope,
  resolvePublicEnvelopeSchema,
  validatePublicEnvelopeInput,
  isPublicEnvelope,
  PUBLIC_ENVELOPE_FIELDS,
  DEFAULT_PUBLIC_ENVELOPE_SCHEMA,
  PUBLIC_ENVELOPE_RECORD_ID,
  readNoydbBundlePublicEnvelope,
} from '../src/index.js'
import type {
  Cover,
  CoverText,
  CoverSchema,
  CoverField,
  ResolvedCoverSchema,
  SetCoverInput,
  PublicEnvelope,
  PublicEnvelopeText,
  PublicEnvelopeSchema,
  PublicEnvelopeField,
  ResolvedPublicEnvelopeSchema,
  SetPublicEnvelopeInput,
} from '../src/index.js'

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

const SECRET = 'correct horse battery staple printer toaster'
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('#799 — deprecated value aliases are the same runtime values', () => {
  it('every old export is identical (===) to its new canonical export', () => {
    expect(loadPublicEnvelope).toBe(loadCover)
    expect(savePublicEnvelope).toBe(saveCover)
    expect(readPublicEnvelope).toBe(readCover)
    expect(resolvePublicEnvelopeSchema).toBe(resolveCoverSchema)
    expect(validatePublicEnvelopeInput).toBe(validateCoverInput)
    expect(isPublicEnvelope).toBe(isCover)
    expect(PUBLIC_ENVELOPE_FIELDS).toBe(COVER_FIELDS)
    expect(DEFAULT_PUBLIC_ENVELOPE_SCHEMA).toBe(DEFAULT_COVER_SCHEMA)
    expect(PUBLIC_ENVELOPE_RECORD_ID).toBe(COVER_RECORD_ID)
    expect(readNoydbBundlePublicEnvelope).toBe(readPodCover)
  })

  it('the record id VALUE keeps the frozen wire name', () => {
    expect(COVER_RECORD_ID).toBe('public-envelope')
  })
})

describe('#799 — deprecated Noydb/Vault methods delegate', () => {
  it('setPublicEnvelope/getPublicEnvelope still work with the deprecated publicEnvelope option key', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: SECRET,
      publicEnvelope: true, // deprecated key, still accepted
    })
    const vault = await db.openVault('acme')
    const written = await db.setPublicEnvelope('acme', { name: 'Acme 2026' })
    expect(written.version).toBe(1)
    expect((await db.getPublicEnvelope('acme'))?.name).toBe('Acme 2026')
    expect((await db.getCover('acme'))?.name).toBe('Acme 2026')
    expect((await vault.getPublicEnvelope())?.name).toBe('Acme 2026')
    expect((await vault.getCover())?.name).toBe('Acme 2026')
  }, 60_000)

  it('the canonical cover option key feeds the deprecated methods too', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: SECRET,
      cover: true,
    })
    await db.openVault('acme')
    await db.setPublicEnvelope('acme', { name: 'Acme 2026' })
    expect((await db.getCover('acme'))?.name).toBe('Acme 2026')
  }, 60_000)

  it('when both option keys are set, cover wins', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: SECRET,
      cover: { fields: ['name'] }, // narrow — no icon
      publicEnvelope: true, // full default schema would allow icon
    })
    await db.openVault('acme')
    // icon is outside cover's narrow allowlist → the narrow schema won.
    await expect(
      db.setCover('acme', { name: 'OK', icon: TINY_PNG }),
    ).rejects.toBeInstanceOf(ValidationError)
    await db.setCover('acme', { name: 'OK' })
    expect((await db.getCover('acme'))?.name).toBe('OK')
  }, 60_000)
})

describe('#799 — deprecated type aliases still resolve', () => {
  it('old type names are assignable to/from the new canonical types', () => {
    const cover: Cover = { _noydb_public: 1, version: 1, name: 'Acme' }
    const legacy: PublicEnvelope = cover
    const roundTrip: Cover = legacy
    const text: PublicEnvelopeText = 'Acme' satisfies CoverText
    const field: PublicEnvelopeField = 'name' satisfies CoverField
    const schema: PublicEnvelopeSchema = { fields: ['name'] } satisfies CoverSchema
    const resolved: ResolvedPublicEnvelopeSchema | undefined =
      resolveCoverSchema(true) satisfies ResolvedCoverSchema | undefined
    const input: SetPublicEnvelopeInput = { name: 'Acme' } satisfies SetCoverInput
    expect(isCover(roundTrip)).toBe(true)
    expect([text, field, schema, resolved, input].length).toBe(5)
  })
})
