/**
 * Cargo capability strategy (FR-6/FR-7) — the source-side, owner-level
 * partition operation that requires a live {@link Vault}: extracting a re-keyed
 * transfer-sealed partition ({@link extractPartitionCore}). The active engine
 * ({@link withCargo}) dynamically imports that engine (keeping the extraction
 * crypto out of the floor bundle); {@link NO_CARGO} throws.
 *
 * The public free function `extractPartition` (which takes a `Vault`) delegates
 * here via `vault.cargoStrategy`, so an un-opted-in caller hits `NO_CARGO`'s
 * throw.
 *
 * Carve-out (mirrors `openSealedRecord` / `liberateVault`): the recipient-side
 * free functions `adoptPartition` and `decryptExtractedPartition` operate on
 * raw bundle bytes + a destination store — they carry NO source instance to
 * gate against, so they stay ungated host-side tooling. `diffVault` is likewise
 * ungated: it's shared import/merge infrastructure the `as-*` exporters call
 * internally, not a gated cargo capability.
 * @internal
 */
import type { Vault } from '../kernel/vault.js'
import type { ExtractPartitionResult, ExtractPartitionOptions } from './extract-partition.js'
import { CargoNotEnabledError } from '../kernel/errors.js'

export interface CargoStrategy {
  extractPartition(vault: Vault, opts: ExtractPartitionOptions): Promise<ExtractPartitionResult>
}

/**
 * No-op stub — the floor default. The source-side cargo op throws
 * {@link CargoNotEnabledError}; opt in with `cargoStrategy: withCargo()` in
 * createNoydb. @internal
 */
export const NO_CARGO: CargoStrategy = {
  async extractPartition() { throw new CargoNotEnabledError() },
}
