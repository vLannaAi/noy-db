import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory, type InlineMemoryStore } from './harness.js'
import { classified } from '../../src/with-shape/classified/presets.js'
import { withClassified } from '../../src/with-shape/classified/active.js'
import { ClassifiedConfigError } from '../../src/kernel/errors.js'
import type { ClassifiedFieldSpec } from '../../src/with-shape/classified/descriptor.js'

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

  it('a genuinely non-classified collection writes normally (no marker, no throw)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'a', secret: 'pw-s2-8' })
    const v = await db.openVault('v1')
    const plain = v.collection<Record<string, unknown>>('notes', { perRecordKeys: true })
    await expect(plain.put('n1', { title: 'hi' })).resolves.toBeUndefined()
    await expect(plain.put('n1', { title: 'bye' })).resolves.toBeUndefined()
  }, 30_000)
})
