/**
 * Strategy seam for the optional history + ledger + time-machine
 * subsystem. Core imports `HistoryStrategy` type-only + `NO_HISTORY`
 * stub; real implementations of `saveHistory`, `LedgerStore`,
 * `VaultInstant`, `computePatch`, `diff` etc. are only reachable via
 * `withHistory()` in `./active.ts`.
 *
 * Applications that don't track per-record versioning, don't need the
 * hash-chained audit ledger, and don't restore to past instants ship
 * none of the ~1,880 LOC behind this seam.
 *
 * Strategy contract:
 *
 * - **saveHistory / pruneHistory / clearHistory** — no-ops under
 *   NO_HISTORY. Writes still succeed; no snapshot is captured.
 * - **getHistoryEntries / getVersionEnvelope / diff** — throw under
 *   NO_HISTORY. These are read APIs the consumer would only call
 *   after explicitly asking for history; the throw guides them to
 *   `@noy-db/hub/history`.
 * - **envelopePayloadHash / computePatch** — return empty / `[]`
 *   under NO_HISTORY. These are only used inside the
 *   `if (this.ledger)` branch, which is itself gated by
 *   `buildLedger()` returning null.
 * - **buildLedger** — returns `null` under NO_HISTORY. The Vault's
 *   public `vault.ledger()` accessor throws when null.
 * - **buildVaultInstant** — throws under NO_HISTORY. `vault.at()`
 *   propagates the throw.
 *
 * @internal
 */

import type {
  EncryptedEnvelope,
  NoydbStore,
  HistoryOptions,
  PruneOptions,
} from '../types.js'
import type { LedgerStore } from './ledger/store.js'
import type { JsonPatch } from './ledger/patch.js'
import type { DiffEntry } from './diff.js'
import type { VaultInstant, VaultEngine } from './time-machine.js'

/**
 * Options accepted by `HistoryStrategy.buildLedger`. Mirrors the
 * `LedgerStore` constructor verbatim — kept in this file so `core`
 * code never imports the LedgerStore module at runtime.
 *
 * @internal
 */
export interface BuildLedgerOptions {
  adapter: NoydbStore
  vault: string
  encrypted: boolean
  getDEK: (collectionName: string) => Promise<CryptoKey>
  actor: string
}

/**
 * @internal
 */
export interface HistoryStrategy {
  /**
   * Persist a full encrypted envelope snapshot of the prior version
   * under `_history/{collection}:{id}:{paddedVersion}`. No-op under
   * `NO_HISTORY`.
   */
  saveHistory(
    adapter: NoydbStore,
    vault: string,
    collection: string,
    recordId: string,
    envelope: EncryptedEnvelope,
  ): Promise<void>

  /**
   * List history envelopes for a record, newest first. Throws under
   * `NO_HISTORY` — callers reach this via `collection.history()` /
   * `collection.getVersion()` / `collection.diff()`, which only work
   * with the strategy enabled.
   */
  getHistoryEntries(
    adapter: NoydbStore,
    vault: string,
    collection: string,
    recordId: string,
    options?: HistoryOptions,
  ): Promise<EncryptedEnvelope[]>

  /**
   * Fetch a specific version's envelope. Throws under `NO_HISTORY`.
   */
  getVersionEnvelope(
    adapter: NoydbStore,
    vault: string,
    collection: string,
    recordId: string,
    version: number,
  ): Promise<EncryptedEnvelope | null>

  /**
   * Prune history entries by retention rule. Returns `0` under
   * `NO_HISTORY`.
   */
  pruneHistory(
    adapter: NoydbStore,
    vault: string,
    collection: string,
    recordId: string | undefined,
    options: PruneOptions,
  ): Promise<number>

  /**
   * Clear all history for vault/collection/record. Returns `0` under
   * `NO_HISTORY`.
   */
  clearHistory(
    adapter: NoydbStore,
    vault: string,
    collection?: string,
    recordId?: string,
  ): Promise<number>

  /**
   * Compute the SHA-256 hash of an envelope's encrypted payload, used
   * by `LedgerStore.append` to track tamper-evidence. Returns the
   * empty string under `NO_HISTORY` (the call site is gated by
   * `if (this.ledger)`, so the value is never observed).
   */
  envelopePayloadHash(envelope: EncryptedEnvelope | null): Promise<string>

  /**
   * Compute the JSON patch from `from` → `to`. Returns `[]` under
   * `NO_HISTORY`.
   */
  computePatch(from: unknown, to: unknown): JsonPatch

  /**
   * Compute the typed diff between two records. Throws under
   * `NO_HISTORY` — `collection.diff()` is a history-read API.
   */
  diff(recordA: unknown, recordB: unknown): DiffEntry[]

  /**
   * Construct (or return null) a `LedgerStore` for the vault. Returns
   * `null` under `NO_HISTORY`; the Vault treats null as "no ledger
   * attached" — collection write paths skip the append branch and the
   * public `vault.ledger()` accessor throws.
   */
  buildLedger(opts: BuildLedgerOptions): LedgerStore | null

  /**
   * Construct a `VaultInstant` for time-machine reads. Throws under
   * `NO_HISTORY`.
   */
  buildVaultInstant(engine: VaultEngine, timestamp: string): VaultInstant
}

/**
 * Error thrown when the consumer reaches a history-gated surface
 * without opting into the strategy. The message names the offending
 * operation and points to the subpath import.
 *
 * @internal
 */
function notEnabled(op: string): Error {
  return new Error(
    `${op} requires the history strategy. Import ` +
    '`{ withHistory }` from "@noy-db/hub/history" and pass it to ' +
    '`createNoydb({ historyStrategy: withHistory() })`.',
  )
}

/**
 * No-history stub. Snapshots and prune/clear are no-ops; reads and
 * time-machine throw with an actionable message; ledger construction
 * returns null so the write-path's `if (this.ledger)` branch is dead
 * code in the bundle.
 *
 * @internal
 */
export const NO_HISTORY: HistoryStrategy = {
  async saveHistory() {},
  async getHistoryEntries() { throw notEnabled('collection.history()') },
  async getVersionEnvelope() { throw notEnabled('collection.getVersion()') },
  async pruneHistory() { return 0 },
  async clearHistory() { return 0 },
  async envelopePayloadHash() { return '' },
  computePatch() { return [] },
  diff() { throw notEnabled('collection.diff()') },
  buildLedger() { return null },
  buildVaultInstant() { throw notEnabled('vault.at() / vault.timeMachine()') },
}
