/**
 * @category capability
 * Multi-vault partition federation (MVF) — public types for VaultGroup
 * transparent shard routing. See
 * docs/superpowers/specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md.
 */
import type { Vault } from '../vault.js'
import type { Collection } from '../collection.js'
import type { Operator } from '../query/predicate.js'
import type { LiveQuery } from '../query/live.js'
import type { LiveAggregation, AggregateResult, AggregateSpec } from '../aggregate/aggregation.js'

/**
 * A schema blueprint for a class of shard vaults. `configure` is
 * re-applied to every shard handle so all shards are configured
 * identically (collections, indexes, schemas). `version` is recorded
 * into each shard's registry row and drives the fan-out
 * `minVersion` guard.
 */
export interface VaultTemplate {
  readonly version: number
  readonly configure: (vault: Vault) => void
}

/** One row in the StateManagement `vault-registry` collection. */
export interface VaultRegistryRow {
  readonly vaultId: string
  readonly partitionKey: string
  readonly templateName: string
  readonly schemaVersion: number
  readonly createdAt: number
}

/** How a VaultGroup maps records to shards. */
export interface ShardingConfig<T> {
  /** Extract the partition key from a record. */
  readonly keyOf: (record: T) => string
  /** Name of the template (registered via `withVaultTemplate`) shards are stamped from. */
  readonly vaultTemplate: string
  /** When a write targets an unknown partition key, stamp a shard inline. Default `true`. */
  readonly autoCreate?: boolean
}

/** Options for `Noydb.openVaultGroup`. */
export interface VaultGroupOptions<T> {
  /** The `vault-registry` collection (source of truth for shard discovery). */
  readonly registry: Collection<VaultRegistryRow>
  readonly sharding: ShardingConfig<T>
}

/** Options for a cross-shard fan-out read. */
export interface FanoutQueryOptions {
  /** Skip shards whose registry `schemaVersion` is below this. */
  readonly minVersion?: number
  /** Max shards queried in parallel (passed to queryAcross). Default 1. */
  readonly concurrency?: number
}

/** A shard excluded from a fan-out result, with the reason. */
export interface SkippedVault {
  readonly vaultId: string
  readonly reason: 'schema-drift' | 'error' | 'no-grant'
  readonly error?: Error
}

/** The result of a cross-shard fan-out read. */
export interface FanoutResult<R> {
  readonly results: R[]
  readonly skippedVaults: SkippedVault[]
}

/** A single captured where-clause, replayed inside each shard. */
export interface WhereClause {
  readonly field: string
  readonly op: Operator
  readonly value: unknown
}

/** Options for the live/aggregate fan-out (extends the one-shot opts). */
export interface LiveQueryOptions extends FanoutQueryOptions {
  /** Coalesce window before recompute. Default 0 (microtask). */
  readonly debounceMs?: number
}

/** A grouped aggregate output row: the grouped field + the reduced spec result. */
export type GroupedRow<F extends string, Spec extends AggregateSpec> =
  { readonly [K in F]: unknown } & AggregateResult<Spec>

/** Reactive cross-shard record (or grouped-row) query — array-shaped, mirrors LiveQuery<T>. */
export interface CrossVaultLiveQuery<T> extends LiveQuery<T> {
  readonly skippedVaults: readonly SkippedVault[]
  readonly ready: Promise<void>
}

/** Reactive cross-shard scalar aggregate — mirrors LiveAggregation<R>. */
export interface CrossVaultLiveAggregation<R> extends LiveAggregation<R> {
  readonly skippedVaults: readonly SkippedVault[]
  readonly ready: Promise<void>
}
