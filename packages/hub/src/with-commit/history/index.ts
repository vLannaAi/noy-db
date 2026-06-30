/**
 * `@noy-db/hub/history` — subpath export for record-history / diff /
 * ledger-based audit trail + point-in-time primitives.
 *
 * Solo apps that don't track versioning, don't need a hash-chained
 * audit log, and don't restore to earlier points in time can exclude
 * this entire surface. Bundle savings ~1,880 LOC.
 *
 * The strategy seam is `withHistory()` — pass the returned
 * strategy to `createNoydb({ historyStrategy: ... })`. Without it,
 * the core `NO_HISTORY` stub no-ops snapshots/prune/clear and throws
 * on read APIs (`history`, `getVersion`, `diff`, `vault.at`,
 * `vault.ledger`).
 *
 * Named re-exports (not `export *`) so tsup keeps the barrel
 * populated even with `sideEffects: false`.
 */

// ─── Strategy seam ─────────────────────────────────────
export { withHistory } from './active.js'
export type { HistoryStrategy } from './strategy.js'

// ─── Per-record history ──────────────────────────────────
export {
  saveHistory,
  getHistory,
  getVersionEnvelope,
  pruneHistory,
  clearHistory,
} from './history.js'

// ─── Diff ────────────────────────────────────────────────
export { diff, formatDiff } from './diff.js'
export type { ChangeType, DiffEntry } from './diff.js'

// ─── Hash-chained ledger ─────────────────────────────────
export {
  LedgerStore,
  LEDGER_COLLECTION,
  LEDGER_DELTAS_COLLECTION,
  envelopePayloadHash,
} from './ledger/store.js'
export type { AppendInput, VerifyResult } from './ledger/store.js'

export {
  canonicalJson,
  sha256Hex,
  hashEntry,
  paddedIndex,
  parseIndex,
} from './ledger/entry.js'
export type { LedgerEntry } from './ledger/entry.js'

// ─── JSON Patch — delta history ──────────────────────────
export { computePatch, applyPatch } from './ledger/patch.js'
export type { JsonPatch, JsonPatchOp } from './ledger/patch.js'

// ─── Time-machine queries ──────────────────────────────
export { VaultInstant, CollectionInstant } from './time-machine.js'
export type { VaultEngine } from './time-machine.js'
