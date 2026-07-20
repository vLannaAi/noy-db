import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory } from './harness.js'
import { classified } from '../../src/via/classified/presets.js'
import { withClassified } from '../../src/via/classified/active.js'
import { withConsent } from '../../src/with-audit/consent/index.js'
import { ClassifiedRevealError } from '../../src/kernel/errors.js'

// Group form exactly as stage-1 reveal-gate.test.ts declares it:
async function openCards(consent = false) {
  const store = inlineMemory()
  const db = await createNoydb({
    store, user: 'a', secret: 'pw-s2-16b', classifiedStrategy: withClassified(),
    ...(consent ? { consentStrategy: withConsent() } : {}),
  })
  const v = await db.openVault('v1')
  const c = v.collection<Record<string, unknown>>('cards', {
    classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
  })
  return { store, v, c }
}

describe('I6 — reveal rework parity (three fail-closed gates + single consent op)', () => {
  it('reveals the sealed plaintext (byte-parity with stage 1)', async () => {
    const { c } = await openCards()
    await c.put('r1', { pan: '4242424242424242' })
    expect(await c.reveal('r1', 'pan')).toBe('4242424242424242')
  })

  it('gate (b): record not found → ClassifiedRevealError', async () => {
    const { c } = await openCards()
    await expect(c.reveal('ghost', 'pan')).rejects.toBeInstanceOf(ClassifiedRevealError)
  })

  it('gate (c): absent _sealed slot → ClassifiedRevealError, never a TypeError', async () => {
    const { c } = await openCards()
    await c.put('r1', {})                     // record exists, pan never written
    const err = await c.reveal('r1', 'pan').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClassifiedRevealError)
    expect(err).not.toBeInstanceOf(TypeError)
  })

  it("consent: exactly one 'reveal' entry and ZERO 'get' entries per reveal", async () => {
    const { v, c } = await openCards(true)
    await c.put('r1', { pan: '4242424242424242' })
    await v.withConsent({ purpose: 'support', consentHash: 'h' }, async () => {
      await c.reveal('r1', 'pan')
    })
    const log = await v.consentAudit({})
    expect(log.filter((e: { op: string }) => e.op === 'reveal').length).toBe(1)
    expect(log.filter((e: { op: string }) => e.op === 'get').length).toBe(0)   // the I6 double-entry bug
  })
})
