/**
 * The enclave verify oracle (spec §3). Verdict-only egress: no path
 * distinguishes "record missing" / "no digest" / "AAD-tamper" / "mismatch"
 * beyond { ok: false } — existence oracles are oracles too. Every path that
 * cannot run a real comparison runs ONE dummy PBKDF2 + ONE dummy tag-compare
 * first (C4), so wall-clock cannot enumerate records/fields/answers.
 * Throws are reserved for caller/config bugs (ClassifiedVerifyError /
 * ClassifiedConfigError) and are exempt from the pad by design (R6 note).
 * @module
 */
import { generateSalt, base64ToBuffer, type EnclaveKey } from '../crypto.js'
import { pbkdf2VerifyDigest, VDIG_ITERATIONS } from './digest.js'
import { normalizeForVerify, type VerifyNormalizeMode } from './normalize.js'
import { blindedEqual } from './compare.js'
import { evaluateKofN } from './kofn.js'
import { openVdigPayload, type VdigPayload } from './vdig.js'
import { dualReadSealedSlot } from '../record-keys/sealed-slot.js'
import { ClassifiedConfigError, ClassifiedVerifyError } from '../../errors.js'
import type { EncryptedEnvelope, VdigFieldPolicy, ClassifiedVerdict } from '../../types.js'

export interface VerifyEngineCtx {
  readonly collection: string
  getEnvelope(id: string): Promise<EncryptedEnvelope | null>
  resolveCek(env: EncryptedEnvelope): Promise<EnclaveKey | undefined>
  getDEK(): Promise<EnclaveKey>
  readonly now: () => number
}

/** C4 pad: one full-cost dummy digest + one dummy compare; result discarded. */
async function padOnce(): Promise<void> {
  const dummy = await pbkdf2VerifyDigest('noydb-classify-c4-pad', generateSalt(), VDIG_ITERATIONS)
  await blindedEqual(dummy, dummy)
}

async function padFalse(): Promise<ClassifiedVerdict> {
  await padOnce()
  return { ok: false }
}

/** R6 verify-side transition evidence — config bug, fail-loud, pad-exempt. */
function refuseSealedResidue(collection: string, field: string): never {
  throw new ClassifiedConfigError(collection,
    `field "${field}" carries a recoverable _sealed slot but no _vdig — storage-form ` +
    `transition detected (R6); refused fail-loud, never an ok:false masquerading as wrong-password`)
}

export async function verifyDigestField(
  ctx: VerifyEngineCtx,
  id: string,
  field: string,
  candidate: string,
  policy: VdigFieldPolicy,
): Promise<ClassifiedVerdict> {
  const env = await ctx.getEnvelope(id)
  if (env === null) return padFalse()
  const blob = env._vdig?.[field]
  if (blob === undefined) {
    if (env._sealed?.[field] !== undefined) refuseSealedResidue(ctx.collection, field)
    return padFalse()
  }
  const cek = await ctx.resolveCek(env)
  if (cek === undefined) return padFalse()

  let payload: VdigPayload
  try {
    payload = await openVdigPayload(blob, cek, ctx.collection, id, field)
  } catch {
    return padFalse() // AAD/tamper (C1) → padded false; no tamper oracle to the caller
  }

  const normalized = normalizeForVerify(policy.normalize, candidate)
  const digest = await pbkdf2VerifyDigest(normalized, base64ToBuffer(payload.cur.salt), payload.iter)
  const ok = await blindedEqual(digest, base64ToBuffer(payload.cur.hash))
  if (!ok) return { ok: false } // I1: bare false — mustRotate never computed here

  if (policy.rotateDays !== undefined
    && ctx.now() > Date.parse(payload.cur.at) + policy.rotateDays * 86_400_000) {
    // Disclosing write-age-vs-policy to a SUCCESSFUL verifier is intended (audit F6).
    return { ok: true, mustRotate: true }
  }
  return { ok: true }
}

export async function verifyTextField(
  ctx: VerifyEngineCtx,
  id: string,
  field: string,
  candidate: string,
  normalize: VerifyNormalizeMode,
): Promise<ClassifiedVerdict> {
  const env = await ctx.getEnvelope(id)
  if (env === null) return padFalse()
  const blob = env._sealed?.[field]
  if (blob === undefined) return padFalse()
  const cek = await ctx.resolveCek(env)
  const dek = await ctx.getDEK()
  let stored: unknown
  try {
    stored = JSON.parse(await dualReadSealedSlot(blob, field, ctx.collection, cek, dek))
  } catch {
    return padFalse()
  }
  // Plaintext exists microseconds inside this function; only the boolean leaves.
  const a = new TextEncoder().encode(normalizeForVerify(normalize, candidate))
  const b = new TextEncoder().encode(normalizeForVerify(normalize, String(stored)))
  return { ok: await blindedEqual(a, b) }
}

export async function matchGroupFields(
  ctx: VerifyEngineCtx,
  id: string,
  answers: Record<string, string>,
  members: ReadonlyArray<{ readonly field: string; readonly policy: VdigFieldPolicy }>,
  opts: { readonly min: number },
): Promise<{ readonly passed: boolean }> {
  // I2 step 1 — validate EVERYTHING up front, before any PBKDF2, throwing
  // uniformly at ~0 elapsed (no member-position leak via timing/throw type).
  if (!Number.isInteger(opts.min) || opts.min < 1 || opts.min > members.length) {
    throw new ClassifiedVerifyError(ctx.collection, '*',
      `matchGroup min ${opts.min} out of range 1..${members.length}`)
  }
  const normalized = new Map<string, string>()
  for (const m of members) {
    const answer = answers[m.field] // non-member answer keys: silently ignored
    if (answer === undefined) continue
    if (typeof answer !== 'string') {
      throw new ClassifiedVerifyError(ctx.collection, m.field, 'candidate must be a string')
    }
    normalized.set(m.field, normalizeForVerify(m.policy.normalize, answer))
  }

  const env = await ctx.getEnvelope(id)
  if (env !== null) {
    for (const m of members) { // R6 evidence — uniform, before any PBKDF2
      if (env._sealed?.[m.field] !== undefined && env._vdig?.[m.field] === undefined) {
        refuseSealedResidue(ctx.collection, m.field)
      }
    }
  }
  const cek = env !== null ? await ctx.resolveCek(env) : undefined

  // I2 step 2+3 — iterate RESOLVED GROUP MEMBERS (denominator = |members|),
  // evaluate EVERY member (collect, never break), pad every no-compare slot.
  const results: boolean[] = []
  for (const m of members) {
    const candidate = normalized.get(m.field)
    const blob = env?._vdig?.[m.field]
    if (env === null || cek === undefined || candidate === undefined || blob === undefined) {
      await padOnce()
      results.push(false)
      continue
    }
    try {
      const payload = await openVdigPayload(blob, cek, ctx.collection, id, m.field)
      const digest = await pbkdf2VerifyDigest(candidate, base64ToBuffer(payload.cur.salt), payload.iter)
      results.push(await blindedEqual(digest, base64ToBuffer(payload.cur.hash)))
    } catch {
      await padOnce()
      results.push(false)
    }
  }
  // Per-member results never appear in any return, error, or audit payload.
  return { passed: evaluateKofN(results, opts.min) }
}
