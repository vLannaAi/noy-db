import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory, type InlineMemoryStore } from './harness.js'
import { classified } from '../../src/via/classified/presets.js'
import { withClassified } from '../../src/via/classified/active.js'
import { ClassifiedConfigError } from '../../src/kernel/errors.js'
import type { ClassifiedFieldSpec } from '../../src/via/classified/descriptor.js'

// Raw digest-only spec (presets land in Task 12; the equatable knob + `_bidx`
// wiring land in Task 10). Both drift vectors below therefore open the
// classified collection through the raw ClassifiedFieldSpec, exactly as the
// other stage-2 integration tests do (see put-carry-forward.test.ts). The
// C-A / R10 guard is collection-level (a persisted x-classified marker), so it
// fires for an equatable-capable field and a pure digest-only field alike.
const passwordSpec: ClassifiedFieldSpec = {
  _noydbClassified: true, preset: 'password', storage: 'digest-only',
  sensitivity: 'secret', list: { kind: 'omit' }, verifyNormalize: 'password',
}
// A second, independent digest-only field, so a PARTIAL handle can declare one
// classified field (note) while the collection carries another (password) it
// does NOT declare — the partial-handle door the superset guard closes.
const noteSpec: ClassifiedFieldSpec = {
  _noydbClassified: true, preset: 'password', storage: 'digest-only',
  sensitivity: 'secret', list: { kind: 'omit' }, verifyNormalize: 'password',
}

/** Seed a two-classified-field record ({password, note}) through a full handle. */
async function seedTwoClassified(store: InlineMemoryStore, record: Record<string, unknown>): Promise<void> {
  const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8' })
  const v = await db.openVault('v1')
  const users = v.collection<Record<string, unknown>>('users', {
    perRecordKeys: true,
    classifiedFields: { password: passwordSpec, note: noteSpec },
  })
  await users.put('r1', record)
}

/** Open a PARTIAL handle: declares `note` but NOT `password`. */
async function openPartial(store: InlineMemoryStore) {
  const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8' })
  const v = await db.openVault('v1')
  return v.collection<Record<string, unknown>>('users', {
    perRecordKeys: true,
    classifiedFields: { note: noteSpec },
  })
}

/**
 * Open the classified `users` collection over a fresh session, write one
 * classified record (persists the x-classified marker), and return the shared
 * store. Reopening the same store in a NEW session (fresh collection cache) is
 * how a naive handle actually arises — within one vault, `v.collection('users')`
 * returns the cached classified instance, so the drift is inherently
 * cross-session (and the persisted marker is the cross-session signal).
 */
async function seedClassified(store: InlineMemoryStore, record: Record<string, unknown>): Promise<void> {
  const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8' })
  const v = await db.openVault('v1')
  const users = v.collection<Record<string, unknown>>('users', {
    perRecordKeys: true,
    classifiedFields: { password: passwordSpec },
  })
  await users.put('r1', record)
}

async function openNaive(store: InlineMemoryStore) {
  const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8' })
  const v = await db.openVault('v1')
  return v.collection<Record<string, unknown>>('users', { perRecordKeys: true })
}

describe('C-A / R10 config-drift guard', () => {
  it('_bidx path: a naive handle writing over an equatable-capable record throws ClassifiedConfigError', async () => {
    const store = inlineMemory()
    await seedClassified(store, { password: 'hunter2-hunter2', name: 'A' })
    const naive = await openNaive(store)
    await expect(naive.put('r1', { name: 'B' })).rejects.toBeInstanceOf(ClassifiedConfigError)
  }, 30_000)

  it('stage-2 _vdig-only back-port: naive handle over a digest-only (non-equatable) record throws too', async () => {
    const store = inlineMemory()
    await seedClassified(store, { password: 'hunter2-hunter2' })
    const naive = await openNaive(store)
    await expect(naive.put('r1', { name: 'B' })).rejects.toBeInstanceOf(ClassifiedConfigError)
  }, 30_000)

  it('a correctly-configured classified handle is unaffected (no false positive)', async () => {
    const store = inlineMemory()
    await seedClassified(store, { password: 'hunter2-hunter2', name: 'A' })
    // reopen WITH the same classified config — must still write fine
    const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8' })
    const v = await db.openVault('v1')
    const users = v.collection<Record<string, unknown>>('users', {
      perRecordKeys: true,
      classifiedFields: { password: passwordSpec },
    })
    await expect(users.put('r1', { name: 'B' })).resolves.toBeUndefined()
  }, 30_000)

  it('literal _bidx path: naive handle over an EQUATABLE record (real _bidx tag present) throws ClassifiedConfigError', async () => {
    // Unlike the first vector (digest-only spec: marker only, no real _bidx),
    // this seeds through an EQUATABLE handle so the persisted envelope carries
    // an actual store-visible `_bidx` tag. R10 must fire for the literal `_bidx`
    // path, not only the `_vdig` back-port — Task 6 deferred this because the
    // equatable API did not yet exist.
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8', classifiedStrategy: withClassified() })
    const v = await db.openVault('v1')
    const eq = v.collection<Record<string, unknown>>('users', {
      perRecordKeys: true,
      acknowledgeEquatableRisk: true,
      classifiedFields: { password: classified.password({ equatable: true }) },
    })
    await eq.put('r1', { password: 'hunter2-hunter2', name: 'A' })
    // sanity: a real `_bidx` tag exists on the seeded envelope
    expect(store._dump('v1', 'users', 'r1')?._bidx?.password).toBeDefined()
    const naive = await openNaive(store)
    await expect(naive.put('r1', { name: 'B' })).rejects.toBeInstanceOf(ClassifiedConfigError)
  }, 30_000)

  it('partial-handle door: a handle declaring {note} but NOT {password} refuses to overwrite a record carrying _vdig[password], and leaks no plaintext', async () => {
    const store = inlineMemory()
    await seedTwoClassified(store, { password: 'hunter2-hunter2', note: 'hunter3-hunter3', name: 'A' })
    // sanity: the stored envelope carries a _vdig slot for BOTH classified fields
    const seeded = store._dump('v1', 'users', 'r1')
    expect(seeded?._vdig?.password).toBeDefined()
    expect(seeded?._vdig?.note).toBeDefined()

    const partial = await openPartial(store)
    // This put CONTAINS password's value. The partial handle does not declare
    // `password`, so without the superset guard the _vdig loop (iterating only
    // {note}) never strips it and it lands in _data as DEK-recoverable plaintext.
    const leaked = 'topsecret-leaked'
    await expect(partial.put('r1', { password: leaked, note: 'hunter4-hunter4', name: 'B' }))
      .rejects.toBeInstanceOf(ClassifiedConfigError)
    // no plaintext leak: the attempted secret appears nowhere in the stored envelope
    expect(JSON.stringify(store._dump('v1', 'users', 'r1'))).not.toContain(leaked)
  }, 30_000)

  it('superset handle (declares a strict SUPERSET of the stored classified set) writes fine — no false refusal', async () => {
    const store = inlineMemory()
    // stored classified set = {password} only …
    await seedClassified(store, { password: 'hunter2-hunter2', name: 'A' })
    // … reopen declaring {password, note} (a strict superset). Must not refuse.
    const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8' })
    const v = await db.openVault('v1')
    const superset = v.collection<Record<string, unknown>>('users', {
      perRecordKeys: true,
      classifiedFields: { password: passwordSpec, note: noteSpec },
    })
    await expect(superset.put('r1', { name: 'B' })).resolves.toBeUndefined()
  }, 30_000)

  it('a genuinely non-classified collection writes normally (no marker, no throw)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8' })
    const v = await db.openVault('v1')
    const plain = v.collection<Record<string, unknown>>('notes', { perRecordKeys: true })
    await expect(plain.put('n1', { title: 'hi' })).resolves.toBeUndefined()
    await expect(plain.put('n1', { title: 'bye' })).resolves.toBeUndefined()
  }, 30_000)
})
