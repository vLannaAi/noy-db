import type { ReadOnlyVaultFacade } from '../../with-audit/guards/types.js'

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

/** Record-shape output — one source row produces (optionally) one output row at the source's id. */
export interface RecordOutputSpec {
  shape: 'record'
  collection: string
  /**
   * When `true`, the `derive` function may return `null` (or
   * `undefined`) for this output key. The executor interprets that as
   * "no output for this invocation": a previously-emitted output at
   * the same id is deleted (mirroring the empty-group / empty-aggregate
   * semantics for empty groups); a never-emitted output is a silent
   * no-op. When `false` (default), returning `null` throws
   * `DerivationOutputShapeError` — same as v1.
   */
  optional?: boolean
  /**
   * Field-level provenance for a **self-write** output (#376) — an output
   * whose `collection` equals the strategy's `source`, used by
   * reverse-denormalization (`triggerBy`) to patch a denormalized field
   * back onto the source record.
   *
   * `denorm` names the ONLY top-level fields the derivation owns on that
   * record. The engine merges just those fields from the `derive` return
   * value onto the current stored record (`{ ...current, ...pick(out, denorm) }`)
   * — the rest of the user's record is never clobbered by a stale snapshot.
   * The whole-record `_derivedFrom` provenance tag is NOT applied (the
   * record stays user-owned); the derivation only claims `denorm`.
   *
   * Cycle break is value-level: if the patch changes nothing, no write is
   * issued — so the self-write that re-fires the source-path derivation
   * terminates after one idempotent pass.
   *
   * REQUIRED when `collection === source` (validated at construction);
   * ignored for outputs to a different collection.
   */
  denorm?: readonly string[]
}

/**
 * Array-shape output — one source row produces a variable-length
 * list of output rows, each with its own id (from the `key` extractor).
 *
 * On every source-row change, the dispatcher diffs the previously
 * emitted key set against the new one: removed keys are deleted via
 * `_internalDelete`, new and unchanged keys are upserted via
 * `Collection.put`. Strict-mode rollback is preserved via the existing
 * `_executed` tracking.
 *
 * Storage of the per-source-row key set lives at
 * `_meta/derivations-fanout/<source>/<sourceId>/<outputKey>` as a
 * plain JSON sidecar — keeps dispatch cost O(1) per source row.
 *
 * **Slice 1 limitation**: only `lifecycle: 'eager'` is supported.
 * Registering an array-shape output with `lifecycle: 'lazy'` throws
 * at `withDerivation` construction time.
 */
export interface ArrayOutputSpec {
  shape: 'array'
  collection: string
  /**
   * Stable identity extractor for each derived row. Called on every
   * row returned by `derive`. The string MUST be unique within a
   * single invocation — duplicate keys throw
   * `DerivationOutputShapeError`.
   *
   * Type is intentionally `(out: Record<string, unknown>) => string`
   * (not generic) because OutputSpec is type-erased at the registry
   * level. Strategy-level inference still produces typed `out`
   * through the strategy's `outputs` map.
   */
  key: (output: Record<string, unknown>) => string
  /**
   * Cap on derived rows per source-row invocation. Defaults to 64.
   * Raise for carry-forward cases (e.g. monthly expansion of
   * multi-year contracts). Exceeding the cap throws
   * `DerivationCapExceededError` BEFORE any writes — partial fanout
   * is never persisted.
   */
  maxFanout?: number
}

/** Discriminated union — record + array. */
export type OutputSpec = RecordOutputSpec | ArrayOutputSpec

/**
 * Registration shape passed to `withDerivation()`.
 *
 * @typeParam TSource - the source record type
 * @typeParam TOutputs - map of output-key → output record type. An output
 *   value may be a single record, or — for `shape: 'array'` outputs — an
 *   array of records (the fanout sidecar upserts/deletes each row).
 */
export interface DerivationStrategy<
  TSource extends Record<string, unknown>,
  TOutputs extends Record<string, Record<string, unknown> | ReadonlyArray<Record<string, unknown>>>,
> {
  /** Source collection name. */
  source: string
  /**
   * Additional collections whose writes ALSO re-fire this derivation
   * (issue #344). By default only writes to the single declared
   * `source` re-trigger a derivation; a `derive` that reads sibling
   * collections via `ctx.vault` therefore goes stale when those
   * siblings change. Declare those sibling collections here to wire
   * them as extra triggers.
   *
   * **SAME-ID assumption (load-bearing):** when a write lands on one of
   * these declared collections, the derivation re-fires with the
   * PRIMARY `source` record read at the SAME id as the written record
   * — NOT the written sibling record itself. If no primary `source`
   * record exists at that id, the re-fire is a silent no-op (no throw,
   * no output mutation). Model your collections so the sibling and the
   * primary share an id (the common money/accounting case: an
   * `allocations` row and its `payments`/`bills` keyed by the same id),
   * or trigger off a collection you control the id-space of.
   *
   * Declared collections participate in cycle detection and are indexed
   * in the registry's `_bySource` exactly like `source`, so a sibling
   * that is also a derivation output forms a detectable cycle.
   *
   * Each entry must be a non-empty string and must not equal `source`
   * (validated at `withDerivation()` construction time).
   */
  sources?: ReadonlyArray<string>
  /**
   * Foreign-key-keyed triggers for reverse-denormalization (#376). Unlike
   * `sources[]` (which re-fires at the SAME id), a `triggerBy` entry fans a
   * write to a PARENT collection OUT to every source record whose FK matches
   * the written parent's id.
   *
   * `{ collection, on }`: a write to `collection` (the parent, e.g.
   * `'buyers'`) re-fires this derivation once per source record where
   * `source[on] === writtenParentId` (`on` is the FK field ON the source,
   * e.g. `'buyerId'`). The matched source record — not the parent — is
   * passed to `derive`.
   *
   * Typical use: keep a denormalized field on the source in sync with a
   * parent change (a buyer rename → refresh `buyerName` on all their sales),
   * via a self-write output (`collection === source`) declaring `denorm`.
   *
   * Fan-out runs through `ctx.vault.collection(source).query().where(on,'==',id)`,
   * which uses the FK index when the source declares `withIndexing()` on
   * `on` (O(children)) and otherwise scans (O(N) — fine for small child
   * sets). Set `maxFanout` as a safety rail; exceeding it throws
   * `DerivationCapExceededError` before any write. `triggerBy` collections
   * participate in cycle detection like `source`/`sources`.
   *
   * Each `collection` must be non-empty and not equal `source`; `on` must
   * be a non-empty field name (validated at construction).
   */
  triggerBy?: ReadonlyArray<{ collection: string; on: string; maxFanout?: number }>
  /**
   * @internal — set by `withRollup()` (#376 slice 2). Marks this strategy as
   * an aggregate-onto-parent rollup: a write OR delete of a `from` (child)
   * record recomputes `compute(children where child[key] === parentId)` and
   * patches it onto `source[field]` of the parent at `parentId` (= child[key]).
   * `source` is the parent (`into`) collection; the synthetic self-write
   * output carries `denorm: [field]`. Dispatch handles rollup specially (it
   * does not run the executor). Eager-only in this slice.
   */
  rollup?: {
    readonly from: string
    readonly key: string
    readonly field: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly compute: (children: any[]) => unknown
  }
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
   *
   * **Per-output omission (runtime-supported):** returning `null` or
   * `undefined` for an individual output key is handled at runtime via
   * the `optional: true` flag on the output's `RecordOutputSpec` —
   * the executor deletes any previously-emitted output at that id, or
   * silently no-ops if none exists. For `shape: 'array'` outputs, null
   * / undefined is treated as an empty array (clears all prior rows for
   * that source). The *top-level* return must always be a `TOutputs`
   * object; returning `null` for the whole result is not supported.
   * (#297 — MV `unionSources` map drop-row is the analogous feature for
   * materialized views.)
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
