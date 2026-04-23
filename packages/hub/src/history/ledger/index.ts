/**
 * Public surface of the ledger module.
 *
 * Consumers import these symbols via `@noy-db/core`:
 *
 * ```ts
 * import { LedgerStore, canonicalJson, hashEntry } from '@noy-db/hub'
 * import type { LedgerEntry, VerifyResult } from '@noy-db/hub'
 * ```
 *
 * The LedgerStore class itself is exported so test code and advanced
 * users can construct one directly, but the recommended entry point is
 * `vault.ledger()` which takes care of wiring the DEK resolver
 * and actor id from the active keyring.
 */

export {
  LedgerStore,
  LEDGER_COLLECTION,
  LEDGER_DELTAS_COLLECTION,
  envelopePayloadHash,
  type AppendInput,
  type VerifyResult,
} from './store.js'

export {
  canonicalJson,
  sha256Hex,
  hashEntry,
  paddedIndex,
  parseIndex,
  type LedgerEntry,
} from './entry.js'

// JSON Patch compute + apply (#44 — v0.4 delta history)
export { computePatch, applyPatch } from './patch.js'
export type { JsonPatch, JsonPatchOp } from './patch.js'
