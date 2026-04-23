/**
 * `@noy-db/hub/history` — subpath export for record-history / diff /
 * ledger-based audit trail + point-in-time primitives.
 *
 * Solo apps that don't track versioning, don't need a hash-chained
 * audit log, and don't restore to earlier points in time can exclude
 * this entire surface. Bundle savings estimated at ~30 KB (history
 * ~5 KB + diff ~3 KB + ledger ~24 KB).
 *
 * The main `@noy-db/hub` entry still re-exports every symbol for
 * backward compatibility through v0.15.x.
 *
 * Named re-exports (not `export *`) so tsup keeps the barrel
 * populated even with `sideEffects: false`.
 */

// ─── Per-record history (v0.4 #42) ──────────────────────────────────
export {
  saveHistory,
  getHistory,
  getVersionEnvelope,
  pruneHistory,
  clearHistory,
} from './history.js'

// ─── Diff (v0.4 #43) ────────────────────────────────────────────────
export { diff, formatDiff } from './diff.js'
export type { ChangeType, DiffEntry } from './diff.js'

// ─── Hash-chained ledger (v0.4 #41) ─────────────────────────────────
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

// ─── JSON Patch — delta history (v0.4 #44) ──────────────────────────
export { computePatch, applyPatch } from './ledger/patch.js'
export type { JsonPatch, JsonPatchOp } from './ledger/patch.js'

// ─── Time-machine queries (v0.16 #215) ──────────────────────────────
export { VaultInstant, CollectionInstant } from './time-machine.js'
export type { VaultEngine } from './time-machine.js'
