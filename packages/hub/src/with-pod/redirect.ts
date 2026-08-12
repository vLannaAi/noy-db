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
import { readPodRedirect } from './pod.js'
import {
  RedirectBadSignatureError,
  RedirectDepthExceededError,
  RedirectLoopError,
  RedirectUnreachableError,
} from '../kernel/errors.js'

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

/** One followed hop's provenance — surfaced so a UI can show "moved from X via Y". */
export interface RedirectHop {
  readonly target: string
  readonly reason: Redirect['reason']
  readonly issuedBy: string
}

/** Result of {@link followRedirects}: the terminal (non-redirect) pod's bytes, plus the ordered hop list that led there. */
export interface FollowRedirectsResult {
  readonly terminal: Uint8Array
  readonly hops: readonly RedirectHop[]
}

/**
 * Follow a chain of Redirect records starting from `start`'s pod bytes,
 * fetching each hop's target via `fetcher`, until a pod with no `redirect`
 * header field (the terminal) is reached.
 *
 * HTTP-redirect discipline: each hop's Redirect is verified against
 * `opts.trustedKeys` BEFORE it is followed (fail closed — an untrusted or
 * forged hop never advances the walk), loops are detected on the target
 * about to be followed, and the hop count is capped at `opts.maxDepth`
 * (default 8). `fetcher` throwing or returning `null` for a target means
 * that hop is unreachable.
 *
 * @throws {RedirectBadSignatureError} a hop's Redirect fails verification.
 * @throws {RedirectLoopError} a hop's target was already followed in this chain.
 * @throws {RedirectDepthExceededError} more than `maxDepth` hops were followed.
 * @throws {RedirectUnreachableError} `fetcher` threw or returned `null` for a target.
 */
export async function followRedirects(
  start: Uint8Array,
  fetcher: (target: string) => Promise<Uint8Array | null>,
  opts: { readonly trustedKeys: Readonly<Record<string, string>>; readonly maxDepth?: number },
): Promise<FollowRedirectsResult> {
  const maxDepth = opts.maxDepth ?? 8
  let current = start
  const hops: RedirectHop[] = []
  const visited = new Set<string>()

  for (;;) {
    const rec = readPodRedirect(current)
    if (rec === undefined) return { terminal: current, hops }

    if (!(await verifyRedirect(rec, opts.trustedKeys))) {
      throw new RedirectBadSignatureError(rec.target)
    }
    if (visited.has(rec.target)) {
      throw new RedirectLoopError(rec.target)
    }
    visited.add(rec.target)

    hops.push({ target: rec.target, reason: rec.reason, issuedBy: rec.issuedBy })
    if (hops.length > maxDepth) {
      throw new RedirectDepthExceededError(maxDepth)
    }

    let next: Uint8Array | null
    try {
      next = await fetcher(rec.target)
    } catch (cause) {
      throw new RedirectUnreachableError(rec.target, cause)
    }
    if (next === null) {
      throw new RedirectUnreachableError(rec.target)
    }
    current = next
  }
}
