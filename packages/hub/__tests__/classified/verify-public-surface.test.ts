import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory } from './harness.js'
import { classified } from '../../src/with-shape/classified/presets.js'
import { withClassified } from '../../src/with-shape/classified/active.js'
import { withConsent } from '../../src/with-audit/consent/index.js'
import { withSealedRecord } from '../../src/with-audit/sealed-record/index.js'
import { ClassifiedNotEnabledError } from '../../src/kernel/errors.js'
import { ClassifiedVerifyError, ClassifiedRevealError } from '../../src/kernel/errors.js'

// NOTE: `withSealedRecord()` is required on this branch for `vault.rotateRecordCek` /
// `vault.revokeSealedRecord` to be anything other than a NO_OP throw — grep
// packages/hub/__tests__ for "withSealedRecord(" if this needs to be updated.
async function openWith(strategy?: ReturnType<typeof withClassified>, consent = false) {
  const store = inlineMemory()
  const db = await createNoydb({
    store, user: 'a', secret: 'pw-s2-15',
    sealedRecordStrategy: withSealedRecord(),
    ...(strategy !== undefined ? { classifiedStrategy: strategy } : {}),
    ...(consent ? { consentStrategy: withConsent() } : {}),
  })
  const v = await db.openVault('v1')
  const c = v.collection<Record<string, unknown>>('users', {
    perRecordKeys: true,
    classifiedFields: {
      password: classified.password(),
      a1: classified.secretAnswer(),
      a2: classified.secretAnswer(),
      email: classified.email(),
    },
  })
  return { store, v, c }
}

describe('collection.verify / verifyGroup (public surface)', () => {
  it('throws ClassifiedNotEnabledError without withClassified()', async () => {
    const { c } = await openWith(undefined)
    await c.put('u1', { password: 'correct-horse-battery' })
    await expect(c.verify('u1', 'password', 'x'.repeat(12))).rejects.toBeInstanceOf(ClassifiedNotEnabledError)
    await expect(c.verifyGroup('u1', {}, { min: 1 })).rejects.toBeInstanceOf(ClassifiedNotEnabledError)
  }, 60_000)

  it('digest path end-to-end: put → verify ok / wrong → bare false', async () => {
    const { c } = await openWith(withClassified())
    await c.put('u1', { password: 'correct-horse-battery', a1: 'Rex', a2: 'Bangkok' })
    expect(await c.verify('u1', 'password', 'correct-horse-battery')).toEqual({ ok: true })
    expect(await c.verify('u1', 'password', 'wrong-password-!!')).toEqual({ ok: false })
  }, 120_000)

  it('C3 vector at the public surface: rotateRecordCek / hard revoke → verify(correct) → ok:true', async () => {
    const { v, c } = await openWith(withClassified())
    await c.put('u1', { password: 'correct-horse-battery' })
    await v.rotateRecordCek('users', 'u1')
    expect(await c.verify('u1', 'password', 'correct-horse-battery')).toEqual({ ok: true })
    await v.revokeSealedRecord('users', 'u1', 'pid-x', { hard: true })
    expect(await c.verify('u1', 'password', 'correct-horse-battery')).toEqual({ ok: true })
  }, 120_000)

  it('recoverable path routes through verifyText (normalize per preset is password/NFC-strict here)', async () => {
    const { c } = await openWith(withClassified())
    await c.put('u1', { email: 'nok@example.com' })
    expect(await c.verify('u1', 'email', 'nok@example.com')).toEqual({ ok: true })
    expect(await c.verify('u1', 'email', 'other@example.com')).toEqual({ ok: false })
  }, 60_000)

  it('caller bugs throw ClassifiedVerifyError: unknown field, storage:never', async () => {
    const { c } = await openWith(withClassified())
    await expect(c.verify('u1', 'nope', 'x')).rejects.toBeInstanceOf(ClassifiedVerifyError)
  })

  it('verifyGroup: k-of-n over the secretAnswer members', async () => {
    const { c } = await openWith(withClassified())
    await c.put('u1', { password: 'correct-horse-battery', a1: 'Rex', a2: 'Bangkok' })
    expect(await c.verifyGroup('u1', { a1: 'rex', a2: 'nope' }, { min: 1 })).toEqual({ passed: true })
    expect(await c.verifyGroup('u1', { a1: 'rex', a2: 'nope' }, { min: 2 })).toEqual({ passed: false })
  }, 240_000)

  it('reveal refuses digest-only fields (presets table §4)', async () => {
    const { c } = await openWith(withClassified())
    await c.put('u1', { password: 'correct-horse-battery' })
    await expect(c.reveal('u1', 'password')).rejects.toBeInstanceOf(ClassifiedRevealError)
  }, 60_000)

  it("Q6: one 'verify' consent entry per verify call and per matchGroup call (not per member)", async () => {
    const { v, c } = await openWith(withClassified(), true)
    await c.put('u1', { password: 'correct-horse-battery', a1: 'Rex', a2: 'Bangkok' })
    await v.withConsent({ purpose: 'login', consentHash: 'h' }, async () => {
      await c.verify('u1', 'password', 'correct-horse-battery')
      await c.verifyGroup('u1', { a1: 'rex', a2: 'bangkok' }, { min: 2 })
    })
    const log = await v.consentAudit({})
    const verifyOps = log.filter((e: { op: string }) => e.op === 'verify')
    expect(verifyOps.length).toBe(2)   // 1 for verify + 1 for the whole group call
  }, 240_000)
})
