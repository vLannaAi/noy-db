/**
 * Cargo capability strategy (FR-6/FR-7) — the source-side, owner-level
 * partition operations that require a live {@link Vault}: extracting a re-keyed
 * transfer-sealed partition ({@link extractPartitionCore}) and diffing a vault
 * against a candidate state ({@link diffVaultCore}). The active engine
 * ({@link withCargo}) dynamically imports those engines (keeping the extraction
 * crypto + diff walk out of the floor bundle); {@link NO_CARGO} throws.
 *
 * The public free functions `extractPartition` / `diffVault` (both take a
 * `Vault`) delegate here via `vault.cargoStrategy`, so an un-opted-in caller
 * hits `NO_CARGO`'s throw.
 *
 * Carve-out (mirrors `openSealedRecord` / `liberateVault`): the recipient-side
 * free functions `adoptPartition` and `decryptExtractedPartition` operate on
 * raw bundle bytes + a destination store — they carry NO source instance to
 * gate against, so they stay ungated host-side tooling.
 * @internal
 */
import type { Vault } from '../kernel/vault.js'
import type { ExtractPartitionResult, ExtractPartitionOptions } from './extract-partition.js'
import type { DiffCandidate, DiffOptions, VaultDiff } from './vault-diff.js'
import { CargoNotEnabledError } from '../kernel/errors.js'

export interface CargoStrategy {
  extractPartition(vault: Vault, opts: ExtractPartitionOptions): Promise<ExtractPartitionResult>
  diffVault<T>(vault: Vault, candidate: DiffCandidate<T>, options?: DiffOptions): Promise<VaultDiff<T>>
}

/**
 * No-op stub — the floor default. Every source-side cargo op throws
 * {@link CargoNotEnabledError}; opt in with `cargoStrategy: withCargo()` in
 * createNoydb. @internal
 */
export const NO_CARGO: CargoStrategy = {
  async extractPartition() { throw new CargoNotEnabledError() },
  async diffVault() { throw new CargoNotEnabledError() },
}
