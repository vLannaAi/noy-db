import { describe, it, expect } from 'vitest'
import { generateDEK, encrypt, deriveSealedFieldKeyFromCek } from '../../src/kernel/enclave/index.js'
import { mintVdigSlot } from '../../src/kernel/enclave/classify/write.js'
import {
  verifyDigestField, verifyTextField, matchGroupFields, type VerifyEngineCtx,
} from '../../src/kernel/enclave/classify/verify.js'
import type { EncryptedEnvelope, VdigFieldPolicy } from '../../src/kernel/types.js'
import { ClassifiedConfigError, ClassifiedVerifyError } from '../../src/kernel/errors.js'

const pw: VdigFieldPolicy = { normalize: 'password', notLastN: 0 }
const sa: VdigFieldPolicy = { normalize: 'secret-answer', notLastN: 0 }

function ctxFor(env: EncryptedEnvelope | null, cek: CryptoKey | undefined, now = () => Date.now()): VerifyEngineCtx {
  return {
    collection: 'users',
    getEnvelope: async () => env,
    resolveCek: async () => cek,
    getDEK: () => generateDEK(), // engine only uses the DEK on the text path
    now,
  }
}

async function envWith(cek: CryptoKey, slots: Record<string, { value: string; policy: VdigFieldPolicy }>, id = 'r1'): Promise<EncryptedEnvelope> {
  const vdig: Record<string, string> = {}
  for (const [f, s] of Object.entries(slots)) {
    vdig[f] = await mintVdigSlot(s.value, s.policy, undefined, cek, 'users', id, f)
  }
  return { _noydb: 1, _v: 1, _ts: 't', _iv: 'x', _data: 'x', _cek: 'wrapped', _vdig: vdig }
}

describe('verifyDigestField', () => {
  it('round-trip: correct candidate → ok:true; wrong → exactly { ok: false }', async () => {
    const cek = await generateDEK()
    const env = await envWith(cek, { password: { value: 'correct-horse-battery', policy: pw } })
    const ctx = ctxFor(env, cek)
    expect(await verifyDigestField(ctx, 'r1', 'password', 'correct-horse-battery', pw)).toEqual({ ok: true })
    const bad = await verifyDigestField(ctx, 'r1', 'password', 'wrong-password-!!', pw)
    expect(bad).toEqual({ ok: false })
    expect('mustRotate' in bad).toBe(false)                    // I1: key ABSENT on false
  }, 120_000)

  it('normalization: secret-answer candidates match case/space-insensitively', async () => {
    const cek = await generateDEK()
    const env = await envWith(cek, { answer: { value: '  Fluffy The Cat ', policy: sa } })
    expect(await verifyDigestField(ctxFor(env, cek), 'r1', 'answer', 'fluffy   the cat', sa)).toEqual({ ok: true })
  }, 120_000)

  it('C1: a blob spliced from another record verifies { ok: false }, never a tamper throw', async () => {
    const cek = await generateDEK()
    const env1 = await envWith(cek, { password: { value: 'correct-horse-battery', policy: pw } }, 'r1')
    const spliced: EncryptedEnvelope = { ...env1 } // engine reads it as r2's envelope
    expect(await verifyDigestField(ctxFor(spliced, cek), 'r2', 'password', 'correct-horse-battery', pw)).toEqual({ ok: false })
  }, 120_000)

  it('I1: mustRotate decorates ONLY ok:true, when now() exceeds cur.at + rotateDays', async () => {
    const cek = await generateDEK()
    const rot: VdigFieldPolicy = { normalize: 'password', notLastN: 0, rotateDays: 30 }
    const env = await envWith(cek, { password: { value: 'correct-horse-battery', policy: rot } })
    const future = () => Date.now() + 31 * 86_400_000
    expect(await verifyDigestField(ctxFor(env, cek, future), 'r1', 'password', 'correct-horse-battery', rot))
      .toEqual({ ok: true, mustRotate: true })
    expect(await verifyDigestField(ctxFor(env, cek, future), 'r1', 'password', 'wrong-password-!!', rot))
      .toEqual({ ok: false })                                   // stale AND wrong → still bare false
  }, 120_000)

  it('R6 verify-side: _sealed[field] present with no _vdig[field] throws ClassifiedConfigError', async () => {
    const cek = await generateDEK()
    const env: EncryptedEnvelope = {
      _noydb: 1, _v: 1, _ts: 't', _iv: 'x', _data: 'x', _cek: 'w',
      _sealed: { password: 'iv:stale' },
    }
    await expect(verifyDigestField(ctxFor(env, cek), 'r1', 'password', 'anything-here', pw))
      .rejects.toBeInstanceOf(ClassifiedConfigError)
  })

  it('C4 timing parity: missing record / missing slot cost within the wrong-candidate envelope', async () => {
    const cek = await generateDEK()
    const env = await envWith(cek, { password: { value: 'correct-horse-battery', policy: pw } })
    const time = async (fn: () => Promise<unknown>) => {
      const t0 = performance.now(); await fn(); return performance.now() - t0
    }
    const wrong = await time(() => verifyDigestField(ctxFor(env, cek), 'r1', 'password', 'wrong-password-!!', pw))
    const missingRecord = await time(() => verifyDigestField(ctxFor(null, cek), 'r1', 'password', 'wrong-password-!!', pw))
    const missingSlot = await time(() => verifyDigestField(ctxFor({ ...env, _vdig: {} }, cek), 'r1', 'password', 'wrong-password-!!', pw))
    // The 600K PBKDF2 dominates (~100ms+); an unpadded miss returns in <5ms.
    expect(missingRecord).toBeGreaterThan(wrong * 0.4)
    expect(missingSlot).toBeGreaterThan(wrong * 0.4)
  }, 120_000)
})

describe('matchGroupFields (I2)', () => {
  async function groupFixture() {
    const cek = await generateDEK()
    const env = await envWith(cek, {
      a1: { value: 'Rex', policy: sa },
      a2: { value: 'Bangkok', policy: sa },
      a3: { value: 'Somsri', policy: sa },
    })
    const members = [
      { field: 'a1', policy: sa }, { field: 'a2', policy: sa }, { field: 'a3', policy: sa },
    ] as const
    return { ctx: ctxFor(env, cek), members: [...members] }
  }

  it('k-of-n: 2 of 3 correct passes min 2; 1 of 3 fails; per-member results never egress', async () => {
    const { ctx, members } = await groupFixture()
    const pass = await matchGroupFields(ctx, 'r1', { a1: 'rex', a2: 'bangkok', a3: 'wrong' }, members, { min: 2 })
    expect(pass).toEqual({ passed: true })
    expect(Object.keys(pass)).toEqual(['passed'])              // aggregate ONLY
    expect(await matchGroupFields(ctx, 'r1', { a1: 'rex', a2: 'no', a3: 'no' }, members, { min: 2 }))
      .toEqual({ passed: false })
  }, 240_000)

  it('missing answers contribute false (denominator = |groupMembers|); non-member keys silently ignored', async () => {
    const { ctx, members } = await groupFixture()
    expect(await matchGroupFields(ctx, 'r1', { a1: 'rex', notAMember: 'probe' }, members, { min: 1 }))
      .toEqual({ passed: true })
    expect(await matchGroupFields(ctx, 'r1', { a1: 'rex' }, members, { min: 2 }))
      .toEqual({ passed: false })
  }, 240_000)

  it('I2c: min bounds throw ClassifiedVerifyError uniformly BEFORE any PBKDF2 (fast)', async () => {
    const { ctx, members } = await groupFixture()
    const t0 = performance.now()
    await expect(matchGroupFields(ctx, 'r1', {}, members, { min: 0 })).rejects.toBeInstanceOf(ClassifiedVerifyError)
    await expect(matchGroupFields(ctx, 'r1', {}, members, { min: 4 })).rejects.toBeInstanceOf(ClassifiedVerifyError)
    expect(performance.now() - t0).toBeLessThan(50)            // ~0 elapsed — no member work leaked
  }, 240_000)
})

describe('verifyTextField', () => {
  /** Mint a CEK-sealed `_sealed[field]` slot exactly as the record codec writes it. */
  async function sealedEnvWith(cek: CryptoKey, field: string, value: string): Promise<EncryptedEnvelope> {
    const fieldKey = await deriveSealedFieldKeyFromCek(cek, 'users', field)
    const { iv, data } = await encrypt(JSON.stringify(value), fieldKey)
    return { _noydb: 1, _v: 1, _ts: 't', _iv: 'x', _data: 'x', _cek: 'wrapped', _sealed: { [field]: `${iv}:${data}` } }
  }

  it('caller-bug: this engine door never accepts a digest-only slot (no _sealed) → padded false', async () => {
    const cek = await generateDEK()
    const env = await envWith(cek, { password: { value: 'correct-horse-battery', policy: pw } })
    expect(await verifyTextField(ctxFor(env, cek), 'r1', 'password', 'correct-horse-battery', 'password'))
      .toEqual({ ok: false })
  }, 120_000)

  it('round-trip: correct → ok:true; wrong → ok:false; tampered slot → ok:false, never a throw', async () => {
    const cek = await generateDEK()
    const env = await sealedEnvWith(cek, 'ssn', 'sensitive-value-42')
    expect(await verifyTextField(ctxFor(env, cek), 'r1', 'ssn', 'sensitive-value-42', 'password')).toEqual({ ok: true })
    expect(await verifyTextField(ctxFor(env, cek), 'r1', 'ssn', 'wrong-value', 'password')).toEqual({ ok: false })
    const tampered: EncryptedEnvelope = { ...env, _sealed: { ssn: 'aaaa:bbbb' } }
    expect(await verifyTextField(ctxFor(tampered, cek), 'r1', 'ssn', 'sensitive-value-42', 'password')).toEqual({ ok: false })
  }, 120_000)

  it('C4 timing parity: present-correct / present-wrong / missing record / missing slot all pay the uniform pad', async () => {
    const cek = await generateDEK()
    const env = await sealedEnvWith(cek, 'ssn', 'sensitive-value-42')
    const time = async (fn: () => Promise<unknown>) => {
      const t0 = performance.now(); await fn(); return performance.now() - t0
    }
    const correct = await time(() => verifyTextField(ctxFor(env, cek), 'r1', 'ssn', 'sensitive-value-42', 'password'))
    const wrong = await time(() => verifyTextField(ctxFor(env, cek), 'r1', 'ssn', 'wrong-value', 'password'))
    const missingRecord = await time(() => verifyTextField(ctxFor(null, cek), 'r1', 'ssn', 'wrong-value', 'password'))
    const missingSlot = await time(() => verifyTextField(ctxFor({ ...env, _sealed: {} }, cek), 'r1', 'ssn', 'wrong-value', 'password'))
    // The unconditional 600K-PBKDF2 pad dominates (~100ms+); a path that skipped
    // it would return in <5ms. Pairwise generous bounds, same style as the
    // digest-path vector — every outcome must sit inside every other's envelope.
    expect(correct).toBeGreaterThan(wrong * 0.4)
    expect(wrong).toBeGreaterThan(correct * 0.4)
    expect(missingRecord).toBeGreaterThan(wrong * 0.4)
    expect(missingSlot).toBeGreaterThan(wrong * 0.4)
    expect(wrong).toBeGreaterThan(missingRecord * 0.4)
    expect(wrong).toBeGreaterThan(missingSlot * 0.4)
  }, 120_000)
})
