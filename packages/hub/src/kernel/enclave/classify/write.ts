/**
 * Digest-only write engine (C6 rotate branch + notLastN ring, spec §2/§4).
 * Called ONLY by RecordCodec.encryptRecord — both live inside the enclave.
 * @module
 */
import { generateSalt, bufferToBase64, base64ToBuffer, type EnclaveKey } from '../crypto.js'
import { pbkdf2VerifyDigest, VDIG_ITERATIONS } from './digest.js'
import { normalizeForVerify } from './normalize.js'
import { blindedEqual } from './compare.js'
import { sealVdigPayload, openVdigPayload, type VdigPayload, type VdigDigestEntry } from './vdig.js'
import { ClassifiedRotationError, TamperedError } from '../../errors.js'
import type { VdigFieldPolicy } from '../../types.js'

export async function mintVdigSlot(
  rawValue: string,
  policy: VdigFieldPolicy,
  prevBlob: string | undefined,
  cek: EnclaveKey,
  collection: string,
  recordId: string,
  field: string,
): Promise<string> {
  const normalized = normalizeForVerify(policy.normalize, rawValue)

  let prev: VdigPayload | null = null
  if (prevBlob !== undefined) {
    try {
      prev = await openVdigPayload(prevBlob, cek, collection, recordId, field)
    } catch {
      // Any failure opening a prior _vdig slot (auth-tag mismatch, malformed
      // JSON, wrong AAD) is a tamper/false condition — normalize to
      // TamperedError so the write path never sees a distinct error shape.
      throw new TamperedError()
    }
    if (!Number.isInteger(prev.iter) || prev.iter < 1) {
      // A corrupted/tampered iter count would silently weaken (or break)
      // the reuse-check PBKDF2 pass — floor/validate before trusting it.
      throw new TamperedError()
    }
  }

  // notLastN reuse refusal: candidate vs cur + every ring entry, each a full
  // PBKDF2 at the payload's own iteration count (n × 600K is the documented
  // write-time cost ceiling, cap 8 — spec Q4).
  if (prev !== null && policy.notLastN > 0) {
    const history: readonly VdigDigestEntry[] = [prev.cur, ...(prev.ring ?? [])]
    for (const entry of history) {
      const digest = await pbkdf2VerifyDigest(normalized, base64ToBuffer(entry.salt), prev.iter)
      if (await blindedEqual(digest, base64ToBuffer(entry.hash))) {
        throw new ClassifiedRotationError(collection, field, 'password was used recently')
      }
    }
  }

  const salt = generateSalt()
  const hash = await pbkdf2VerifyDigest(normalized, salt, VDIG_ITERATIONS)
  const ring = prev !== null && policy.notLastN > 0
    ? [...(prev.ring ?? []), { salt: prev.cur.salt, hash: prev.cur.hash }].slice(-policy.notLastN)
    : undefined

  const payload: VdigPayload = {
    v: 1,
    alg: 'PBKDF2-SHA256',
    iter: VDIG_ITERATIONS,
    cur: { salt: bufferToBase64(salt), hash: bufferToBase64(hash), at: new Date().toISOString() },
    ...(ring !== undefined && ring.length > 0 ? { ring } : {}),
  }
  return sealVdigPayload(payload, cek, collection, recordId, field)
}
