/**
 * Blind-index slow-tag primitive for classified `equatable` fields (stage 2).
 *
 * `mintBidxTag` mints a deterministic, key-and-cost-gated tag —
 * `COST_BYTE ‖ HMAC-SHA256(K_idx, PBKDF2-SHA256(normalized, salt_cf))` — that
 * lets `find.ts` do blind equality lookup over an otherwise-opaque field
 * without ever storing the plaintext or a fast dictionary-crackable digest.
 *
 * Rationale (M-2/I3, spec §4/Crypto #1):
 *  - The outer HMAC is **keyed** by `K_idx`, a DEK-derived key never seen by
 *    the store. A key-less adversary (store access only) cannot mint a
 *    candidate tag to test against the index at all — the HMAC blocks the
 *    classic "key-less dictionary attack" a plain digest would invite.
 *  - The inner `pbkdf2VerifyDigest` (stage-2, `digest.ts`) reuses the
 *    existing 600K-iteration cost floor, so even a **DEK holder** who can
 *    compute `K_idx` still pays the PBKDF2 cost per guess — minting is not
 *    free just because you crossed the door.
 *  - Neither control is the real security boundary: the DOOR (who is ever
 *    handed the DEK to begin with) is. These two costs only shape the
 *    economics for whoever is already inside; they do not substitute for
 *    access control.
 *
 * `K_idx` and `salt_cf` are separate HKDF derivations off the same DEK
 * (L-1, #554 precedent: dedicated keys from day one, no shared/legacy form) —
 * sign-key hygiene, not `HMAC(K_idx, const)`. Both derivations are
 * domain-separated per `(collection, field)` so a tag cannot be replayed
 * across fields or collections (join-attack separation).
 *
 * `CURRENT_COST_BYTE` is a 1-byte discriminator prefixed onto every tag so a
 * future iteration-tier bump can mint new tags while old ones still parse:
 * an unknown discriminator is a cheap, immediate non-match instead of a
 * PBKDF2 run at the wrong iteration count.
 *
 * @module
 */
import type { EnclaveKey } from '../crypto.js'
import { bufferToBase64 } from '../crypto.js'
import { pbkdf2VerifyDigest, VDIG_ITERATIONS } from './digest.js'

const subtle = globalThis.crypto.subtle

/** HKDF salt domain for the `K_idx` (blind-index HMAC key) derivation. */
export const CLASSIFY_INDEX_KEY_DOMAIN = 'noydb-classify-index-v1'

/** HKDF salt domain for the `salt_cf` (per collection/field PBKDF2 salt) derivation. */
export const CLASSIFY_INDEX_SALT_DOMAIN = 'noydb-classify-index-salt-v1'

/** Cost-byte discriminator: version 1, iteration-tier 600K. */
export const COST_BYTE_V1 = 0x01
/** The cost byte new tags are minted at. */
export const CURRENT_COST_BYTE = COST_BYTE_V1

/**
 * Map a tag's cost-byte discriminator to its PBKDF2 iteration count.
 * An unrecognized discriminator returns `null` — a mismatched/legacy byte
 * is a cheap non-match, never a PBKDF2 run at the wrong tier.
 */
export function iterationsForCostByte(b: number): number | null {
  if (b === COST_BYTE_V1) return VDIG_ITERATIONS
  return null
}

/**
 * Derive the collection+field's dedicated blind-index HMAC key `K_idx` from
 * the DEK via HKDF-SHA256. Non-extractable, `sign`-only — it never leaves
 * this module in usable form.
 */
export async function deriveClassifyIndexKey(
  dek: EnclaveKey,
  collection: string,
  field: string,
): Promise<EnclaveKey> {
  const rawDek = await subtle.exportKey('raw', dek)
  const hkdfKey = await subtle.importKey('raw', rawDek, 'HKDF', false, ['deriveBits'])
  const salt = new TextEncoder().encode(CLASSIFY_INDEX_KEY_DOMAIN)
  const info = new TextEncoder().encode(JSON.stringify([CLASSIFY_INDEX_KEY_DOMAIN, collection, field]))
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, 256)
  return subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

/**
 * Derive the collection+field's dedicated PBKDF2 salt `salt_cf` from the DEK
 * via a SEPARATE HKDF-deriveBits (distinct from {@link deriveClassifyIndexKey}
 * — sign-key hygiene, not `HMAC(K_idx, const)`). 32 raw bytes.
 */
export async function deriveClassifyIndexSalt(
  dek: EnclaveKey,
  collection: string,
  field: string,
): Promise<Uint8Array> {
  const rawDek = await subtle.exportKey('raw', dek)
  const hkdfKey = await subtle.importKey('raw', rawDek, 'HKDF', false, ['deriveBits'])
  const salt = new TextEncoder().encode(CLASSIFY_INDEX_SALT_DOMAIN)
  const info = new TextEncoder().encode(JSON.stringify([CLASSIFY_INDEX_SALT_DOMAIN, collection, field]))
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, 256)
  return new Uint8Array(bits)
}

/**
 * Mint a blind-index tag at a given cost byte:
 * `tag = base64(COST_BYTE ‖ HMAC(K_idx, PBKDF2(normalized, salt_cf, iterations-for(COST_BYTE))))`.
 * Factored out of {@link mintBidxTag} so `find.ts`'s `computeBidxTarget` can
 * reuse the same crypto at a caller-chosen cost byte (e.g. to evaluate a
 * legacy tier) without duplicating the derivation/digest/MAC pipeline.
 */
export async function mintAt(
  normalized: string,
  dek: EnclaveKey,
  collection: string,
  field: string,
  costByte: number,
): Promise<string> {
  const iterations = iterationsForCostByte(costByte)
  if (iterations == null) {
    throw new Error(`bidx: unknown cost byte 0x${costByte.toString(16)}`)
  }
  const saltCf = await deriveClassifyIndexSalt(dek, collection, field)
  const inner = await pbkdf2VerifyDigest(normalized, saltCf, iterations)
  const kIdx = await deriveClassifyIndexKey(dek, collection, field)
  const mac = await subtle.sign('HMAC', kIdx, inner as BufferSource)
  const tag = new Uint8Array(1 + 32)
  tag[0] = costByte
  tag.set(new Uint8Array(mac), 1)
  return bufferToBase64(tag)
}

/**
 * Mint a blind-index tag for an already-normalized value at
 * {@link CURRENT_COST_BYTE}. The caller normalizes once via
 * `normalizeForVerify` (the shared pipeline with `mintVdigSlot`) —
 * `mintBidxTag` never re-normalizes.
 */
export async function mintBidxTag(
  normalized: string,
  dek: EnclaveKey,
  collection: string,
  field: string,
): Promise<string> {
  return mintAt(normalized, dek, collection, field, CURRENT_COST_BYTE)
}
