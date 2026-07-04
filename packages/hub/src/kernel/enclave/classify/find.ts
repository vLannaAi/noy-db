/**
 * Query-side blind-index target derivation for classified `equatable`
 * fields (stage 2). `computeBidxTarget` normalizes a caller-supplied
 * candidate and mints it into the same 33-byte `_bidx` tag shape produced by
 * `mintBidxTag` (`bidx.ts`), so a caller can string-compare the result
 * against a stored tag to answer "does this candidate match?" without ever
 * decrypting or dictionary-attacking the field.
 *
 * Discriminator-scan contract (Oracle #4): a scanning caller reads each
 * stored tag's leading cost-byte discriminator and derives the target tag
 * **once per distinct discriminator present** — never per-record. `find.ts`
 * itself only computes a single target for a single requested `costByte`;
 * the batching-by-discriminator behavior belongs to the scanner
 * (`findByDigest`, a later task), which calls this function once per
 * distinct discriminator it encounters at step 2 of its scan.
 *
 * An unrecognized `costByte` (unknown or legacy tier not yet supported) is a
 * cheap `null` non-match — `computeBidxTarget` never runs PBKDF2 at a wrong
 * iteration tier just to produce a target that could not possibly match.
 * A legacy tag of a KNOWN older tier remains matchable today by passing that
 * tier's `costByte` explicitly (v1-only today: `CURRENT_COST_BYTE` is the
 * only recognized tier, so this is a future-proofing hook, not live behavior
 * yet).
 *
 * @module
 */
import type { EnclaveKey } from '../crypto.js'
import { mintAt, iterationsForCostByte, CURRENT_COST_BYTE } from './bidx.js'
import { normalizeForVerify, type VerifyNormalizeMode } from './normalize.js'

/**
 * Normalize `candidate` and mint it into a blind-index target tag at
 * `costByte` (default {@link CURRENT_COST_BYTE}), for string-comparison
 * against a stored `_bidx` tag. Returns `null` when `costByte` is not a
 * recognized discriminator — no PBKDF2 is attempted at an unknown/wrong
 * tier (Oracle #4).
 */
export async function computeBidxTarget(
  candidate: string,
  normalize: VerifyNormalizeMode,
  dek: EnclaveKey,
  collection: string,
  field: string,
  costByte?: number,
): Promise<string | null> {
  const resolvedCostByte = costByte ?? CURRENT_COST_BYTE
  const iters = iterationsForCostByte(resolvedCostByte)
  if (iters === null) return null
  const normalized = normalizeForVerify(normalize, candidate)
  return mintAt(normalized, dek, collection, field, resolvedCostByte)
}
