/**
 * Redirect record (#944) — a signed "this moved, go there" pointer carried
 * in the pod's PLAINTEXT header (`NoydbPodHeader.redirect`, see
 * `format.ts`) so a dispatcher can follow it pre-auth: no secret, no
 * decompression.
 *
 * The record carries its OWN inner `sig` (via `signRecord`/`verifyRecord`
 * from `signature.ts`) — independent from, and in addition to, the #943
 * pod-header signature. A Redirect is REQUIRED to be signed: there is no
 * legacy unsigned install base for this new record type, so an absent or
 * invalid signature is invalid for following, not merely "unverified".
 *
 * Minimum-disclosure: the record is kept to exactly
 * `{ v, target, reason, issuedBy, sig }` — no timestamps, no identities
 * beyond the signer's `keyId` fingerprint.
 */

import type { DocSigner } from '../with-audit/attestation/signer.js'
import { signRecord, verifyRecord } from './signature.js'

/**
 * A signed pointer to another pod. `target` is a locator string or URL —
 * the forthcoming #945 `Locator` type isn't built yet, so `target` stays a
 * plain string for now (forward-seam noted, not blurred: a Redirect says
 * "go elsewhere once"; a Locator will say "where cargo lives").
 */
export interface Redirect {
  readonly v: 1
  readonly target: string
  readonly reason: 'moved' | 'release' | 'tombstone' | 'repoint'
  readonly issuedBy: string
  readonly sig: string
}

/**
 * Sign a new Redirect record with `signer`. Builds the record minus `sig`,
 * signs it via the #943 `signRecord` convention, and returns the complete
 * signed record.
 */
export async function signRedirect(
  signer: DocSigner,
  fields: { readonly target: string; readonly reason: Redirect['reason'] },
): Promise<Redirect> {
  const record = {
    v: 1 as const,
    target: fields.target,
    reason: fields.reason,
    issuedBy: signer.keyId,
  }
  const sig = await signRecord(signer.privateKeyPkcs8B64, record)
  return { ...record, sig }
}

/**
 * Verify a Redirect record's signature against `trustedKeys`
 * (`keyId → publicKeyB64`). Fails closed: an `issuedBy` not present in
 * `trustedKeys` is untrusted/unverifiable and returns `false`, same as a
 * tampered or forged signature.
 */
export async function verifyRedirect(
  record: Redirect,
  trustedKeys: Readonly<Record<string, string>>,
): Promise<boolean> {
  const publicKeyB64 = trustedKeys[record.issuedBy]
  if (publicKeyB64 === undefined) return false
  const payload = { v: record.v, target: record.target, reason: record.reason, issuedBy: record.issuedBy }
  return verifyRecord(publicKeyB64, record.sig, payload)
}
