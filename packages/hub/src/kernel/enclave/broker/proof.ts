/**
 * Credential-broker proof crypto (#479, credential-broker spec §3).
 *
 * The `_broker` seed (32 random bytes, decrypted from `_broker/<brokerId>` by
 * the party layer) is never transmitted. Instead, a **proof key** is
 * HKDF-derived from it, domain-separated per `(vaultId, brokerId)`, and the
 * derived bits are registered with the broker host once at enrol. Steady
 * state, the client re-derives the same key from the seed and signs a
 * **canonical** string binding the request's identity/context, so the broker
 * can verify a fresh HMAC on every mint without ever holding the seed itself.
 *
 * ## Derivation (spec §3, follow verbatim)
 *
 * ```
 * hkdf      = importKey('raw', seed, 'HKDF', false, ['deriveBits'])
 * proofBits = deriveBits({ name:'HKDF', hash:'SHA-256',
 *                          salt: utf8(BROKER_PROOF_DOMAIN),
 *                          info: utf8(JSON.stringify([BROKER_PROOF_DOMAIN, vaultId, brokerId])) },
 *                        hkdf, 256)
 * proofKey  = importKey('raw', proofBits, { name:'HMAC', hash:'SHA-256' }, false, ['sign'])
 * proof     = base64(sign('HMAC', proofKey, utf8(canonical)))
 * ```
 *
 * `BROKER_PROOF_DOMAIN` is both the HKDF salt and the first `info` array
 * element (the injective-JSON-array convention `deriveClassifyIndexKey`
 * established — see `classify/bidx.ts`). `BROKER_PROOF_VERSION` is the
 * separate MAC version tag, the first element of the `canonical` array.
 *
 * ## Canonical (spec §2 step 3)
 *
 * `JSON.stringify([BROKER_PROOF_VERSION, vaultId, endpointOrigin, brokerId,
 * profile ?? '', instancePid ?? '', challenge, expiresAt])` — every binding
 * field folded into ONE MAC input:
 *  - `vaultId` (V1), `challenge` (V3), `expiresAt` (V4) — verbatim strings,
 *    never reparsed/reformatted (F8): a byte-identical ISO string is
 *    required, so e.g. `Z` vs `+00:00` for the same instant fails.
 *  - `profile ?? ''` (F1) — a proof captured at one profile cannot be
 *    replayed at another.
 *  - `endpointOrigin` (F4) — a proof cannot be relayed to a different broker
 *    endpoint reusing the same `brokerId`.
 *  - `instancePid ?? ''` (F7) — an EMPTY STRING `instancePid` is forbidden in
 *    both {@link computeBrokerProof} and {@link verifyBrokerProof}: absent
 *    (the field omitted) and `''` must stay distinguishable, or `?? ''`
 *    would alias "no instance" onto a real registered instance.
 *
 * ## Verify order (spec §3, non-negotiable, F2/F6)
 *
 * {@link verifyBrokerProof} MUST, in this exact order: (1) burn the challenge
 * via `consumeChallenge` FIRST and short-circuit `false` before any MAC work
 * (F2 — burn-on-presentation, not burn-on-success); (2) recompute the
 * canonical and compare with `crypto.subtle.verify('HMAC', …)` — portable,
 * constant-time, never a manual byte compare or Node `timingSafeEqual` (F6);
 * (3) assert `now < expiresAt` — the client clock is never trusted, so this
 * check only matters once the MAC (which covers `expiresAt`) has verified.
 *
 * ## Zeroing (F5)
 *
 * `seed` and the transient HKDF output are raw, durable secret material —
 * the `recovery.ts:276-307` `try{}finally{secret.fill(0)}` discipline, not
 * the ephemeral-CEK happy-path zeroing elsewhere. {@link computeBrokerProof}
 * zeroes the `seed` argument in a `finally` on every path including a throw;
 * {@link deriveBrokerProofKey} zeroes its own transient HKDF-output bytes the
 * same way. {@link deriveBrokerProofBits} does not zero `seed` — it exists
 * so the party layer can register the raw bits at one-time enrol (the value
 * that must survive the call to be base64-encoded and POSTed).
 *
 * @module
 */
import type { EnclaveKey } from '../crypto.js'
import { base64ToBuffer, bufferToBase64 } from '../crypto.js'
import { ValidationError } from '../../errors.js'

const subtle = globalThis.crypto.subtle

/** HKDF salt domain for the broker proof key — also the first `info` array element. */
export const BROKER_PROOF_DOMAIN = 'noydb-broker-proof'

/** MAC version tag — the first element of the `canonical` array signed/verified. */
export const BROKER_PROOF_VERSION = 'noydb-broker-proof-v1'

/** Default challenge TTL (spec §2 step 2: "TTL ≤ 60 s"). */
const DEFAULT_CHALLENGE_TTL_MS = 60_000

/** The canonical-binding fields a client supplies alongside `vaultId`/`brokerId` (spec §2 step 3). */
export interface BrokerProofCanonicalParts {
  readonly endpointOrigin: string
  readonly profile?: string | undefined
  readonly instancePid?: string | undefined
  readonly challenge: string
  readonly expiresAt: string
}

/** A freshly-minted, server-random single-use challenge (spec §2 step 2). */
export interface IssuedChallenge {
  readonly challenge: string
  readonly expiresAt: string
}

/** Arguments the broker host passes to verify a submitted proof (spec §3). */
export interface VerifyBrokerProofArgs {
  /**
   * Atomically test-and-delete the challenge, returning whether it was still
   * fresh (unconsumed and unexpired-from-the-store's-perspective). MUST burn
   * on presentation, not on successful verification (F2).
   */
  readonly consumeChallenge: (challenge: string) => Promise<boolean>
  /** The registered proof key's raw bytes, already KMS-unwrapped by the host (§7). */
  readonly registeredProofKey: Uint8Array
  readonly vaultId: string
  readonly endpointOrigin: string
  readonly brokerId: string
  readonly profile?: string | undefined
  readonly instancePid?: string | undefined
  readonly challenge: string
  readonly expiresAt: string
  /** base64(HMAC-SHA-256(proofKey, canonical)), as submitted by the client. */
  readonly proof: string
}

/** Build the canonical MAC input verbatim — never reparses/reformats a field (F8). */
function buildCanonical(vaultId: string, brokerId: string, parts: BrokerProofCanonicalParts): string {
  return JSON.stringify([
    BROKER_PROOF_VERSION,
    vaultId,
    parts.endpointOrigin,
    brokerId,
    parts.profile ?? '',
    parts.instancePid ?? '',
    parts.challenge,
    parts.expiresAt,
  ])
}

/**
 * The HKDF step: derive the 256-bit proof bits from the `_broker` seed,
 * domain-separated per `(vaultId, brokerId)`. Returns the raw bits — the
 * value registered with the broker host once at enrol (spec §2 step 2/3).
 * Does not mutate or zero `seed`; the caller owns the seed's lifecycle.
 */
export async function deriveBrokerProofBits(
  seed: Uint8Array,
  vaultId: string,
  brokerId: string,
): Promise<Uint8Array> {
  const hkdfKey = await subtle.importKey('raw', seed as BufferSource, 'HKDF', false, ['deriveBits'])
  const salt = new TextEncoder().encode(BROKER_PROOF_DOMAIN)
  const info = new TextEncoder().encode(JSON.stringify([BROKER_PROOF_DOMAIN, vaultId, brokerId]))
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, 256)
  return new Uint8Array(bits)
}

/**
 * Derive the steady-state, non-extractable `['sign']` HMAC proof key from
 * the `_broker` seed. Zeroes the transient HKDF-output bytes in a `finally`
 * once the key has been imported (F5) — the raw bits never leave this
 * function in usable form after import.
 */
export async function deriveBrokerProofKey(
  seed: Uint8Array,
  vaultId: string,
  brokerId: string,
): Promise<EnclaveKey> {
  const proofBits = await deriveBrokerProofBits(seed, vaultId, brokerId)
  try {
    return await subtle.importKey('raw', proofBits as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  } finally {
    proofBits.fill(0)
  }
}

/**
 * Compose derive + sign for the client: re-derive the proof key from the
 * seed and sign the canonical over `canonicalParts` (spec §2 step 3).
 *
 * Rejects an empty-string `instancePid` (F7 — absent is fine, `''` is not).
 * Zeroes the `seed` argument in a `finally` on EVERY path including a throw
 * (F5, durable-secret discipline) — the transient HKDF bits are zeroed one
 * layer down, inside {@link deriveBrokerProofKey}.
 */
export async function computeBrokerProof(
  seed: Uint8Array,
  vaultId: string,
  brokerId: string,
  canonicalParts: BrokerProofCanonicalParts,
): Promise<string> {
  try {
    if (canonicalParts.instancePid === '') {
      throw new ValidationError(
        "computeBrokerProof: instancePid must not be an empty string — omit the field entirely for " +
          "'no instance' (F7); '' would alias onto a registered instance.",
      )
    }
    const canonical = buildCanonical(vaultId, brokerId, canonicalParts)
    const key = await deriveBrokerProofKey(seed, vaultId, brokerId)
    const mac = await subtle.sign('HMAC', key, new TextEncoder().encode(canonical) as BufferSource)
    return bufferToBase64(new Uint8Array(mac))
  } finally {
    seed.fill(0)
  }
}

/**
 * Host-side nonce mint: 32 random bytes, base64-encoded, plus an ISO
 * `expiresAt` at most `ttlMs` (default 60 s) in the future. The caller
 * (the broker host) persists both returned strings **verbatim** and MACs
 * those exact bytes on verify — never a reparsed/reformatted copy (F8).
 */
export function issueChallenge(opts?: { ttlMs?: number }): IssuedChallenge {
  const ttlMs = opts?.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  return {
    challenge: bufferToBase64(bytes),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  }
}

/**
 * Verify a submitted broker proof. Order is NON-NEGOTIABLE (spec §3):
 *
 * 1. `await consumeChallenge(challenge)` FIRST — burn-and-check-fresh; a
 *    not-fresh (already-consumed or unknown) challenge short-circuits to
 *    `false` before any MAC work (F2).
 * 2. Empty-string `instancePid` is rejected (F7), then the canonical is
 *    recomputed over the verbatim `endpointOrigin`/`brokerId`/`profile`/
 *    `instancePid`/`challenge`/`expiresAt` and compared via
 *    `crypto.subtle.verify('HMAC', …)` — portable, constant-time, never a
 *    manual compare or Node `timingSafeEqual` (F6).
 * 3. `now < expiresAt` — the client clock is never trusted; `expiresAt`
 *    rides inside the already-verified MAC (F4/F8).
 */
export async function verifyBrokerProof(args: VerifyBrokerProofArgs): Promise<boolean> {
  const fresh = await args.consumeChallenge(args.challenge)
  if (!fresh) return false

  if (args.instancePid === '') return false

  const canonical = buildCanonical(args.vaultId, args.brokerId, {
    endpointOrigin: args.endpointOrigin,
    profile: args.profile,
    instancePid: args.instancePid,
    challenge: args.challenge,
    expiresAt: args.expiresAt,
  })
  const key = await subtle.importKey(
    'raw',
    args.registeredProofKey as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const ok = await subtle.verify(
    'HMAC',
    key,
    base64ToBuffer(args.proof) as BufferSource,
    new TextEncoder().encode(canonical) as BufferSource,
  )
  if (!ok) return false

  return Date.now() < Date.parse(args.expiresAt)
}
