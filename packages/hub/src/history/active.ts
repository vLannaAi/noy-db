/**
 * Active history strategy — `withHistory()` returns the real
 * implementation that wires per-record snapshots, the hash-chained
 * audit ledger, JSON-patch deltas, and time-machine reads into the
 * core write/read paths.
 *
 * Consumers opt in by:
 *
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { withHistory } from '@noy-db/hub/history'
 *
 * const db = await createNoydb({
 *   store: ...,
 *   user: ...,
 *   historyStrategy: withHistory(),
 * })
 * ```
 *
 * The factory is a thin wrapper that delegates to the existing
 * `history.ts`, `diff.ts`, `ledger/store.ts`, `ledger/patch.ts`, and
 * `time-machine.ts` modules. Splitting the import chain through this
 * file is what lets `tsup` tree-shake the heavy modules out of the
 * default `@noy-db/hub` bundle when no `withHistory()` import is
 * present in the consumer.
 *
 * @public
 */

import type { HistoryStrategy, BuildLedgerOptions } from './strategy.js'
import {
  saveHistory,
  getHistory,
  getVersionEnvelope,
  pruneHistory,
  clearHistory,
} from './history.js'
import { diff as computeDiff } from './diff.js'
import { LedgerStore, envelopePayloadHash } from './ledger/store.js'
import { computePatch } from './ledger/patch.js'
import { VaultInstant } from './time-machine.js'

/**
 * Build the active history strategy. Today the factory takes no
 * options; per-collection retention tuning still flows through
 * `HistoryConfig` on `Vault.collection()` / `vault.openVault()`.
 *
 * Future option slots (kept off the LTS surface for now):
 *   - global maxVersions cap
 *   - global beforeDate prune cadence
 *   - ledger encryption toggle (today inferred from vault.encrypted)
 */
export function withHistory(): HistoryStrategy {
  return {
    saveHistory,
    getHistoryEntries: getHistory,
    getVersionEnvelope,
    pruneHistory,
    clearHistory,
    envelopePayloadHash,
    computePatch,
    diff: computeDiff,
    buildLedger(opts: BuildLedgerOptions): LedgerStore {
      return new LedgerStore({
        adapter: opts.adapter,
        vault: opts.vault,
        encrypted: opts.encrypted,
        getDEK: opts.getDEK,
        actor: opts.actor,
      })
    },
    buildVaultInstant(engine, timestamp): VaultInstant {
      return new VaultInstant(engine, timestamp)
    },
  }
}
