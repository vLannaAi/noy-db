import type { ReadOnlyVaultFacade } from '../guards/types.js'

/**
 * Runtime context handed to `derive(source, ctx)`. Mirrors `GuardContext`'s
 * narrow shape: read-only vault access, no write capability, no
 * transaction handle. Determinism is the consumer's responsibility — the
 * strategy hash includes `derive.toString()`, so the source string fixes
 * the function's inputs; whatever sibling reads `derive` performs must
 * yield the same outputs for the same source.
 */
export interface DerivationContext {
  vault: ReadOnlyVaultFacade
}

/**
 * Metadata that travels inside the `_data` payload of a derived record.
 * Lives in encrypted payload, not in the unencrypted envelope — the
 * storage backend cannot infer the derivation graph from listing.
 */
export interface DerivedFromMeta {
  /** Source collection name. */
  readonly source: string
  /** Source record id. */
  readonly sourceId: string
  /** `_v` of the source at derivation time. */
  readonly sourceVersion: number
  /** ISO timestamp when this output was derived. */
  readonly derivedAt: string
  /**
   * SHA-256 of (source + outputs map keys + derive function source).
   * Changes when the strategy changes → forces `vault.deriveAll` to
   * recompute on next visit.
   */
  readonly strategyHash: string
}

/** Per-output declaration. v1: only `'record'` shape. */
export interface OutputSpec {
  shape: 'record'
  collection: string
}

/**
 * Registration shape passed to `withDerivation()`.
 *
 * @typeParam TSource - the source record type
 * @typeParam TOutputs - map of output-key → output record type
 */
export interface DerivationStrategy<
  TSource extends Record<string, unknown>,
  TOutputs extends Record<string, Record<string, unknown>>,
> {
  /** Source collection name. */
  source: string
  /** v1: only deterministic derivations supported. */
  deterministic: true
  /**
   * Output declarations keyed by name. The `derive` function's return
   * value must have the same keys.
   */
  outputs: { [K in keyof TOutputs]: OutputSpec }
  /**
   * Pure function from source to outputs. Runs on plaintext, after DEK
   * unwrap. Returns a map of named outputs. Each output is encrypted +
   * stored via the existing `Collection.put` pipeline.
   *
   * `ctx.vault` is the same `ReadOnlyVaultFacade` guards see — fetch
   * sibling records via `ctx.vault.collection<T>(name).get(id)` /
   * `.list()` / `.query()`. The vault accessor is read-only; there is
   * no path to a writer from `ctx`.
   */
  derive: (source: TSource, ctx: DerivationContext) => Promise<TOutputs> | TOutputs
  /**
   * `'eager'` runs `derive` synchronously inside the source-write
   * transaction. `'lazy'` marks outputs stale on source-change and
   * derives on first read.
   */
  lifecycle: 'eager' | 'lazy' | { mode: 'eager' | 'lazy'; maxDepth?: number }
  /**
   * `true` = any output failure rolls back the source write (only with
   * `withTransactions`). `false` = isolate per-output failure, log,
   * continue. Default `false`.
   */
  strict?: boolean
}

/** Returned by `withDerivation()` and consumed by `createNoydb`. */
export interface DerivationStrategyHandle {
  readonly __noydb_strategy: 'derivation'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly spec: DerivationStrategy<any, any>
}
