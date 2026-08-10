/**
 * Task 13 — `collection.findByDigest`: the equatable blind-index lookup.
 *
 * The security-critical, audit-load-bearing vectors (spec §3):
 *   - round-trip (hit → [id]; wrong → [])
 *   - R9 / Oracle #6: the three field mis-declarations throw ONE
 *     indistinguishable message (no field-enumeration oracle).
 *   - C-B store-shape: exactly `list + N get`, ZERO extra gets even with hits
 *     (the confirm re-reads the already-fetched envelope, never the store).
 *   - I-1: the ONE target PBKDF2 runs UNCONDITIONALLY before the scan — an
 *     empty collection still pays it (no inverted-economics early return).
 *   - C-B TOCTOU: a rotate interleaved between scan and confirm does not drop
 *     a scan-time match (the in-hand envelope keeps it).
 *   - splice: a tag copied A→B returns only A (confirm-by-verify rejects B).
 *   - ring-not-indexed: after a rotate, findByDigest(oldSecret) → [].
 * @module
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory, spyStore, type InlineMemoryStore } from './harness.js'
import { classified } from '../../src/via/classified/presets.js'
import { withClassified } from '../../src/via/classified/active.js'
import { withConsent } from '../../src/with-audit/consent/index.js'
import { ClassifiedVerifyError } from '../../src/kernel/errors.js'
import type { EncryptedEnvelope } from '../../src/kernel/types.js'
import type { ClassifiedStrategy } from '../../src/via/classified/strategy.js'
import type { ClassifiedEntry } from '../../src/via/classified/descriptor.js'

let seq = 0
async function openEquatable(
  store: InlineMemoryStore,
  opts: { strategy?: ClassifiedStrategy; extraFields?: Record<string, ClassifiedEntry> } = {},
) {
  const db = await createNoydb({
    store, user: 'a', secret: `pw-fbd-${seq++}`,
    classifiedStrategy: opts.strategy ?? withClassified(),
  })
  const v = await db.openVault('v1')
  const c = v.collection<Record<string, unknown>>('users', {
    perRecordKeys: true,
    acknowledgeEquatableRisk: true,
    classifiedFields: {
      password: classified.password({ equatable: true }),
      ...(opts.extraFields ?? {}),
    },
  })
  return { db, v, c }
}

/** Await a call and capture whatever it throws (null when it resolves). */
async function grab(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); return null } catch (e) { return e }
}

describe('findByDigest', () => {
  it('round-trip: hit returns the matching id; wrong candidate → []', async () => {
    const { c } = await openEquatable(inlineMemory())
    await c.put('r1', { password: 'password-r1-secret' })
    await c.put('r2', { password: 'password-r2-secret' })
    expect(await c.findByDigest('password', 'password-r1-secret')).toEqual(['r1'])
    expect(await c.findByDigest('password', 'nope-not-here-xx')).toEqual([])
  }, 120_000)

  it('R9: not-classified / not-digest-only / not-equatable all throw ONE indistinguishable message', async () => {
    const { c } = await openEquatable(inlineMemory(), {
      extraFields: { secret: classified.password(), email: classified.email() },
    })
    const notClassified = await grab(() => c.findByDigest('nope', 'x'.repeat(12)))     // sub-case 1
    const notDigestOnly = await grab(() => c.findByDigest('email', 'x'.repeat(12)))    // sub-case 2 (recoverable)
    const notEquatable = await grab(() => c.findByDigest('secret', 'x'.repeat(12)))    // sub-case 3 (digest-only, equatable off)
    for (const e of [notClassified, notDigestOnly, notEquatable]) {
      expect(e).toBeInstanceOf(ClassifiedVerifyError)
    }
    const messages = [notClassified, notDigestOnly, notEquatable].map((e) => (e as Error).message)
    expect(new Set(messages).size).toBe(1)   // ONE constant string — no per-case leak
  }, 60_000)

  it('C-B store-shape: exactly list + N get, ZERO extra gets regardless of hit count', async () => {
    const spy = spyStore(inlineMemory())
    const { c } = await openEquatable(spy)
    await c.put('r1', { password: 'shared-secret-value' })
    await c.put('r2', { password: 'shared-secret-value' })
    await c.put('r3', { password: 'shared-secret-value' })   // 3 tag-hits
    spy.calls.length = 0
    const hits = await c.findByDigest('password', 'shared-secret-value')
    expect(hits).toEqual(['r1', 'r2', 'r3'])
    const kinds = spy.calls.map((x) => x.op)
    expect(kinds.filter((k) => k === 'list')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'get')).toHaveLength(3)   // == N, NOT N + hits
    expect(kinds.every((k) => k === 'list' || k === 'get')).toBe(true)  // no puts / extra ops
    expect(kinds).toHaveLength(4)                               // 1 list + 3 get, nothing else
  }, 120_000)

  it('I-1 empty-collection: runs exactly one PBKDF2 before the scan, no pre-target early return', async () => {
    const spy = spyStore(inlineMemory())
    const active = withClassified()
    let storeCallsBeforeTarget = -1
    const strategy: ClassifiedStrategy = {
      ...active,
      async computeTarget(ctx, field, candidate, costByte) {
        storeCallsBeforeTarget = spy.calls.filter((c) => c.op === 'list' || c.op === 'get').length
        return active.computeTarget(ctx, field, candidate, costByte)
      },
    }
    const { c } = await openEquatable(spy, { strategy })   // no puts → empty collection
    spy.calls.length = 0
    storeCallsBeforeTarget = -1
    const t0 = Date.now()
    const res = await c.findByDigest('password', 'anything-1234')
    const dt = Date.now() - t0
    expect(res).toEqual([])
    expect(storeCallsBeforeTarget).toBe(0)                            // target derived BEFORE any list/get
    // The point of this assertion is that a list RAN — i.e. there was no
    // pre-target early return. It is deliberately not an op budget: this
    // collection was never written to, so its DEK is minted lazily here, and
    // #1010's entitlement probe lists once before minting. The exact-op-budget
    // assertion lives in the populated-collection test above, where the DEK
    // already exists and the probe cannot fire.
    expect(spy.calls.filter((x) => x.op === 'list').length).toBeGreaterThanOrEqual(1)
    expect(dt).toBeGreaterThan(25)                                   // a real 600K PBKDF2 ran, not a ~0ms early return
  }, 60_000)

  it('C-B TOCTOU: a rotate interleaved between scan and confirm does not drop a scan-time match', async () => {
    const base = inlineMemory()
    let armed = false
    let rotatedEnv: EncryptedEnvelope | undefined
    const toctou: InlineMemoryStore = {
      ...base,
      async get(c, col, id) {
        const cur = await base.get(c, col, id)
        if (id === 'r1' && col === 'users' && armed) {
          armed = false
          // the store rotates to the NEW secret NOW — post scan-read, pre confirm.
          if (rotatedEnv) await base.put(c, col, id, rotatedEnv, undefined)
          return cur   // the scan legitimately captured the pre-rotate snapshot
        }
        return cur
      },
      _dump: (c, col, id) => base._dump(c, col, id),
    }
    const { c } = await openEquatable(toctou)
    await c.put('r1', { password: 'toctou-old-secret' })
    await c.put('r1', { password: 'toctou-new-secret' })       // mint the new-secret envelope
    rotatedEnv = toctou._dump('v1', 'users', 'r1')             // capture it (fresh object)
    await c.put('r1', { password: 'toctou-old-secret' })       // restore store to the old secret
    armed = true
    const res = await c.findByDigest('password', 'toctou-old-secret')
    expect(res).toEqual(['r1'])   // in-hand-envelope confirm keeps the scan-time match despite the rotate
  }, 120_000)

  it('splice: a tag copied A→B returns only A (confirm-by-verify rejects the forged B)', async () => {
    const store = inlineMemory()
    const { c } = await openEquatable(store)
    await c.put('r1', { password: 'splice-secret-r1' })
    await c.put('r2', { password: 'splice-secret-r2' })
    const e1 = store._dump('v1', 'users', 'r1')!
    const e2 = store._dump('v1', 'users', 'r2')!
    e2._bidx!.password = e1._bidx!.password!   // forge: r2's tag now equals r1's tag
    expect(await c.findByDigest('password', 'splice-secret-r1')).toEqual(['r1'])  // B fails the _vdig confirm
  }, 120_000)

  it('Oracle #5: exactly ONE find consent op regardless of hit count (3 shared-secret hits → 1 sweep entry)', async () => {
    // Task 13's C-B store-shape vector proved no per-hit STORE op; this proves
    // the CONSENT count. Three records share one secret (3 tag-hits) yet the
    // sweep must record a single `('find','*')` consent entry — never one-per-hit
    // (which would be a hit-count oracle in the audit trail).
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'a', secret: `pw-fbd-${seq++}`,
      classifiedStrategy: withClassified(), consentStrategy: withConsent(),
    })
    const v = await db.openVault('v1')
    const c = v.collection<Record<string, unknown>>('users', {
      perRecordKeys: true,
      acknowledgeEquatableRisk: true,
      classifiedFields: { password: classified.password({ equatable: true }) },
    })
    await c.put('r1', { password: 'oracle5-shared-secret' })
    await c.put('r2', { password: 'oracle5-shared-secret' })
    await c.put('r3', { password: 'oracle5-shared-secret' })   // 3 tag-hits
    const hits = await v.withConsent({ purpose: 'lookup', consentHash: 'h' }, async () =>
      c.findByDigest('password', 'oracle5-shared-secret'),
    )
    expect(hits).toEqual(['r1', 'r2', 'r3'])
    const log = await v.consentAudit({})
    const finds = log.filter((e: { op: string }) => e.op === 'find')
    expect(finds).toHaveLength(1)                          // ONE sweep op, never one-per-hit
    expect(finds[0]!.recordId).toBe('*')                  // the sweep sentinel, not a real id
  }, 120_000)

  it('ring-not-indexed: after a rotate, findByDigest(oldSecret) → []', async () => {
    const store = inlineMemory()
    const { c } = await openEquatable(store)
    await c.put('r1', { password: 'ring-old-secret' })
    await c.put('r1', { password: 'ring-new-secret' })   // rotate the value; old tag replaced
    expect(await c.findByDigest('password', 'ring-old-secret')).toEqual([])
    expect(await c.findByDigest('password', 'ring-new-secret')).toEqual(['r1'])
  }, 120_000)
})
