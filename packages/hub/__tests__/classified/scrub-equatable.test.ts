/**
 * Task 14 — `collection.scrubEquatableTags(field)`: the maintenance sweep that
 * retires a field's `_bidx` index coverage on live records.
 *
 * Vectors:
 *   - I-3 flip-flop (regression pin, already green from Task 5's monotonic
 *     carry): Handle A (equatable) mints r1's tag; Handle B (equatable removed)
 *     does an UNRELATED put on r1; A's findByDigest STILL hits — the tag is
 *     carried verbatim, NOT dropped by a non-equatable handle's write.
 *   - scrub is the ONLY lazy-independent drop-path: `scrubEquatableTags(field)`
 *     returns the count, after which findByDigest misses (index retired) yet
 *     `_vdig` survives so `verify` still returns ok (digest-only preserved).
 *   - ledger consistency: scrubbing a record in a ledgered collection keeps the
 *     hash chain verifiable (no false-tamper flag from the payload-hash change).
 * @module
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { withClassified } from '../../src/via/classified/active.js'
import { inlineMemory, type InlineMemoryStore } from './harness.js'
import { classified } from '../../src/via/classified/presets.js'

let seq = 0

/** Open an equatable-`password` `users` handle over `store`. */
async function openEquatable(store: InlineMemoryStore, secret = `pw-scrub-${seq++}`) {
  const db = await createNoydb({ store, user: 'a', secret, classifiedStrategy: withClassified() })
  const v = await db.openVault('v1')
  const c = v.collection<Record<string, unknown>>('users', {
    perRecordKeys: true,
    acknowledgeEquatableRisk: true,
    classifiedFields: { password: classified.password({ equatable: true }) },
  })
  return { db, c, secret }
}

/** Open a NON-equatable `password` handle over the same store (equatable knob off). */
async function openNonEquatable(store: InlineMemoryStore, secret: string) {
  const db = await createNoydb({ store, user: 'a', secret })
  const v = await db.openVault('v1')
  const c = v.collection<Record<string, unknown>>('users', {
    perRecordKeys: true,
    classifiedFields: { password: classified.password() },
  })
  return { db, c }
}

describe('scrubEquatableTags + monotonic carry (I-3)', () => {
  it('flip-flop: an unrelated put by a non-equatable handle does NOT drop the tag', async () => {
    const store = inlineMemory()
    const { c: a, secret } = await openEquatable(store)
    await a.put('r1', { password: 'flipflop-secret-r1', name: 'Nok' })
    expect(await a.findByDigest('password', 'flipflop-secret-r1')).toEqual(['r1'])

    // Handle B has the equatable knob removed; an unrelated update (password
    // absent) must carry prev._bidx forward verbatim (Task 5 monotonic carry).
    const { c: b } = await openNonEquatable(store, secret)
    await b.put('r1', { name: 'Nok Jaidee' })

    expect(await a.findByDigest('password', 'flipflop-secret-r1')).toEqual(['r1'])
  }, 120_000)

  it('scrubEquatableTags(field) is the only lazy-independent drop-path', async () => {
    const store = inlineMemory()
    const { c: a, secret } = await openEquatable(store)
    await a.put('r1', { password: 'scrub-secret-r1', name: 'Nok' })

    // carry the tag through an unrelated non-equatable write (still hits)
    const { c: b } = await openNonEquatable(store, secret)
    await b.put('r1', { name: 'Nok Jaidee' })
    expect(await a.findByDigest('password', 'scrub-secret-r1')).toEqual(['r1'])

    // scrub retires the index coverage; returns the count
    expect(await a.scrubEquatableTags('password')).toBe(1)

    // findByDigest now misses — the _bidx tag is gone
    expect(await a.findByDigest('password', 'scrub-secret-r1')).toEqual([])

    // ...but _vdig survives: verify still confirms the digest (digest-only intact)
    const env = store._dump('v1', 'users', 'r1')!
    expect(env._vdig?.password).toBeDefined()
    expect(env._bidx).toBeUndefined()
    expect(await a.verify('r1', 'password', 'scrub-secret-r1')).toMatchObject({ ok: true })
  }, 120_000)

  it('scrub returns 0 when no record carries the tag (idempotent second sweep)', async () => {
    const store = inlineMemory()
    const { c: a } = await openEquatable(store)
    await a.put('r1', { password: 'once-secret-r1' })
    expect(await a.scrubEquatableTags('password')).toBe(1)
    expect(await a.scrubEquatableTags('password')).toBe(0)
  }, 120_000)

  it('keeps the ledger hash-chain verifiable after a scrub (no false-tamper flag)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'a', secret: 'pw-scrub-ledger',
      historyStrategy: withHistory(), classifiedStrategy: withClassified(),
    })
    const v = await db.openVault('v1')
    const c = v.collection<Record<string, unknown>>('users', {
      perRecordKeys: true,
      acknowledgeEquatableRisk: true,
      classifiedFields: { password: classified.password({ equatable: true }) },
    })
    await c.put('r1', { password: 'ledger-secret-r1', name: 'Nok' })
    await c.put('r2', { password: 'ledger-secret-r2', name: 'Ploy' })

    expect(await c.findByDigest('password', 'ledger-secret-r1')).toEqual(['r1'])
    const scrubbed = await c.scrubEquatableTags('password')
    expect(scrubbed).toBe(2)

    // The hash chain still verifies — the scrub appended matching ledger entries.
    const ledger = v.ledger()
    expect(await ledger.verify()).toMatchObject({ ok: true })

    // index retired, digest survives
    expect(await c.findByDigest('password', 'ledger-secret-r1')).toEqual([])
    expect(await c.verify('r1', 'password', 'ledger-secret-r1')).toMatchObject({ ok: true })
  }, 120_000)
})
