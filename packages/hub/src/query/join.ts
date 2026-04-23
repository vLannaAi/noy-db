/**
 * Query DSL `.join()` — eager, single-FK, intra-vault joins.
 *
 * v0.6 #73 — resolves a ref()-declared foreign key into an attached
 * right-side record under an alias, using one of two planner paths
 * selected automatically:
 *
 *   - **nested-loop** — right-side source exposes `lookupById`, so
 *     each left row costs O(1). This is the common path for joins
 *     against a Collection, which backs `lookupById` with a Map
 *     lookup.
 *   - **hash** — right-side has only `snapshot()`. Build a
 *     `Map<id, record>` once, probe per left row. Same asymptotic
 *     cost for our collections, but the path exists as a fallback
 *     for custom QuerySource implementations and as an explicit
 *     test-only override via `{ strategy: 'hash' }`.
 *
 * Scope for v0.6:
 *
 *   - Equi-joins on declared `ref()` fields only. Joins on
 *     undeclared fields throw at plan time with an actionable error
 *     naming the field and collection.
 *   - Same-vault only. Cross-vault correlation goes
 *     through `queryAcross` (#63); this is an architectural
 *     invariant, not a limitation we plan to lift.
 *   - Hard row ceiling via `JoinTooLargeError` — default 50k per
 *     side, override via `{ maxRows }`. Warns at 80% of the ceiling
 *     on the existing warn channel.
 *   - Three ref-mode behaviors on dangling refs:
 *     strict → `DanglingReferenceError`,
 *     warn → attach `null` with a one-shot warning,
 *     cascade → attach `null` silently (cascade is a delete-time
 *     mode; any dangling refs still present at read time are
 *     mid-flight cascades or orphans from earlier, not a DSL error).
 *
 * Partition-awareness seam (#87 constraint #1):
 *
 * Every `JoinLeg` carries a `partitionScope` field that is always
 * `'all'` in v0.6. The executor never reads this field. v0.10
 * partition-aware joins will start populating it from `where()`
 * predicates on the partition key without changing the planner's
 * external shape — this is the whole reason it exists now.
 *
 * Joins stay OUT of the ledger: reads don't touch `_ledger/`,
 * including joined reads.
 */

import type { RefDescriptor, RefMode } from '../refs.js'
import { readPath } from './predicate.js'
import { JoinTooLargeError, DanglingReferenceError } from '../errors.js'

/** Planner strategy for a single join leg. Auto-selected unless overridden. */
export type JoinStrategy = 'hash' | 'nested'

/** Default per-side row ceiling before `.join()` throws `JoinTooLargeError`. */
export const DEFAULT_JOIN_MAX_ROWS = 50_000

/**
 * Fraction of the row ceiling at which a one-shot warning is emitted.
 * At 80% we warn; at 100% we throw. The warn gives consumers a
 * heads-up before the hard error so they can raise the ceiling or
 * filter further without first hitting a broken query.
 */
const JOIN_WARN_FRACTION = 0.8

/**
 * Internal representation of a single join leg in the query plan.
 *
 * This is the primary place where #87 constraint #1 is honored:
 * every leg carries a `partitionScope` field that is always `'all'`
 * in v0.6 and is never read by the executor. v0.10 partition-aware
 * joins will start populating it from `where()` predicates on the
 * partition key without changing the planner's external shape.
 */
export interface JoinLeg {
  /** Field on the left-side record holding the foreign key value. */
  readonly field: string
  /** Alias key under which the joined right-side record attaches. */
  readonly as: string
  /** Target collection name, resolved from the `ref()` declaration. */
  readonly target: string
  /** Ref mode controlling behavior on dangling refs at read time. */
  readonly mode: RefMode
  /** Manual planner strategy override. `undefined` → auto-select. */
  readonly strategy: JoinStrategy | undefined
  /** Per-side row ceiling override. `undefined` → DEFAULT_JOIN_MAX_ROWS. */
  readonly maxRows: number | undefined
  /**
   * Partition scope for future partition-aware joins (#87 constraint
   * #1). Always `'all'` in v0.6 — the executor never reads this
   * field. v0.10 will populate it from `where()` predicates without
   * breaking the planner's external shape. Do not remove even though
   * it looks unused today — that's the whole point of having it.
   */
  readonly partitionScope: 'all' | readonly string[]
  /**
   * When `true`, this is a dictionary join (v0.8 #85). The executor
   * resolves the left-field value against the dict snapshot and
   * attaches `{ ...labels, key }` rather than a right-side record.
   * `target` holds the dictionary name (not a collection name).
   */
  readonly isDictJoin?: true
}

/**
 * Minimal shape of a joinable right-side record source.
 *
 * Collections implement this structurally via their `QuerySource`;
 * sources without `lookupById` force the hash-join fallback. Kept as
 * a thin interface so tests can wire up plain-object sources without
 * pulling in the full Collection class.
 *
 * The optional `subscribe` is used by `Query.live()` (#74) to merge
 * right-side change streams into the live re-run trigger. Sources
 * that omit `subscribe` still work for live joins — they just
 * don't drive re-fires when their right side mutates. Collection
 * implements `subscribe` by hooking into the existing per-
 * vault event emitter.
 */
export interface JoinableSource {
  snapshot(): readonly unknown[]
  lookupById?(id: string): unknown
  /**
   * Subscribe to mutations on this source. The callback fires
   * AFTER the underlying record set has been updated. Returns an
   * unsubscribe function. Optional — sources without this method
   * cannot trigger live-join re-fires from their side.
   */
  subscribe?(cb: () => void): () => void
}

/**
 * Join resolution context attached to a `Query` when it's constructed
 * from a `Collection`. Holds everything the `.join()` method needs to
 * translate a field name into a target collection + ref mode, and
 * everything the executor needs to read the right side.
 *
 * Kept as a structural interface so `Vault` can implement it
 * without `Query` needing to import `Vault` (circular-import
 * avoid). The Collection wires this up in its `query()` method using
 * the `joinResolver` back-reference the Vault passes in.
 */
export interface JoinContext {
  /** Name of the left-side (owning) collection. */
  readonly leftCollection: string
  /** Look up a `RefDescriptor` by field name on the left collection. */
  resolveRef(field: string): RefDescriptor | null
  /** Resolve a right-side source by target collection name. */
  resolveSource(collectionName: string): JoinableSource | null
  /**
   * Resolve a dictKey join source (v0.8 #85). Returns a `JoinableSource`
   * whose snapshot exposes `{ key, ...labels }` records, keyed by the
   * stable dictionary key. `null` when the field is not a dictKey.
   *
   * The source is built from the compartment's in-memory dictionary
   * snapshot — same data as `DictionaryHandle.list()`, O(1) per lookup.
   */
  resolveDictSource?(field: string): JoinableSource | null
}

/**
 * Coerce an unknown FK value into a lookup key string.
 *
 * Legitimate ref values are strings or numbers — the same narrowing
 * the write-time `enforceRefsOnPut` path applies. Anything else
 * (objects, arrays, booleans, null, undefined) is treated as "no
 * ref" and returns `null`, so the join attaches `null` instead of
 * running `String({})` and producing `'[object Object]'` as a
 * bucket key. This matches the lint rule guidance and keeps
 * bizarre FK values from producing silently-wrong lookups.
 */
function coerceRefKey(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

/**
 * Warn-channel deduplication for dangling-ref `'warn'` mode. Keyed
 * by `field → target:refId` so the same dangling ref only produces
 * one warning even across many rows or repeated queries.
 */
const warnedDanglingKeys = new Set<string>()
function warnOnceDangling(field: string, target: string, refId: string): void {
  const key = `${field}→${target}:${refId}`
  if (warnedDanglingKeys.has(key)) return
  warnedDanglingKeys.add(key)
  console.warn(
    `[noy-db] .join() encountered dangling ref in 'warn' mode: ` +
      `field "${field}" → "${target}:${refId}" not found. Attaching null.`,
  )
}

/**
 * Track row-ceiling warnings to fire only once per (target, side).
 * Prevents per-query spam when a consumer is running the same query
 * repeatedly (e.g. in a reactive loop).
 */
const warnedCeilingKeys = new Set<string>()
function warnCeilingApproaching(
  target: string,
  side: 'left' | 'right',
  rows: number,
  maxRows: number,
): void {
  const key = `${target}:${side}`
  if (warnedCeilingKeys.has(key)) return
  warnedCeilingKeys.add(key)
  const pct = Math.round((rows / maxRows) * 100)
  console.warn(
    `[noy-db] .join() ${side} side is at ${pct}% of the ${maxRows}-row ` +
      `ceiling for target "${target}" (${rows} rows). Streaming joins over ` +
      `scan() are tracked in issue #76 for collections that need to exceed this.`,
  )
}

/**
 * Apply every join leg in the plan against a base set of left-side
 * rows. Called by the query executor after `where` / `orderBy` /
 * `offset` / `limit` have narrowed the left set.
 *
 * Each leg attaches a `leg.as` field to every row. Returns a new
 * array of plain objects — the original left rows are not mutated
 * (structural sharing is fine for the inner fields, but the
 * top-level object is a fresh clone so consumers can further mutate
 * safely).
 *
 * **Ordering:** joins run AFTER orderBy / limit / offset in v1.
 * This keeps the planner simple and means queries like "top 10
 * invoices with client" sort and paginate the left side first, then
 * join. Sorting *by* a joined field is out of scope for #73 — users
 * can post-sort the result array in userland or wait for #75
 * (multi-FK chaining) which can be layered on top.
 *
 * **Multi-FK chaining (#75):** each leg's `maxRows` is enforced
 * against the current left-row count independently. Because v0.6
 * joins are equi-joins on the target's primary key (one-to-one or
 * one-to-null), the left row count is constant across legs — no
 * cartesian blowup. The per-leg left-side check is still necessary
 * so that a later leg with a tighter ceiling correctly fires on a
 * query like `.join('a', { maxRows: 100_000 }).join('b', { maxRows: 50 })`,
 * which should throw on the second leg if the left set exceeds 50.
 */
export function applyJoins(
  rows: readonly unknown[],
  joins: readonly JoinLeg[],
  context: JoinContext,
): unknown[] {
  if (joins.length === 0) return [...rows]

  let result: unknown[] = [...rows]
  for (const leg of joins) {
    result = applyOneJoin(result, leg, context)
  }
  return result
}

function applyOneJoin(
  leftRows: readonly unknown[],
  leg: JoinLeg,
  context: JoinContext,
): unknown[] {
  // Dict join path (v0.8 #85) — resolve left-field value against the
  // dictionary snapshot and attach { key, ...labels } under leg.as.
  if (leg.isDictJoin) {
    const dictSource = context.resolveDictSource?.(leg.field)
    if (!dictSource) {
      throw new Error(
        `.join() field "${leg.field}" on "${context.leftCollection}" is declared as a ` +
          `dictKey join but the dict source could not be resolved. ` +
          `Ensure the dictionary has at least one entry.`,
      )
    }
    const out: unknown[] = []
    const snapshot = dictSource.snapshot()
    const dictMap = new Map<string, unknown>()
    for (const entry of snapshot) {
      const k = readPath(entry, 'key')
      if (typeof k === 'string') dictMap.set(k, entry)
    }
    for (const left of leftRows) {
      const rawId = readPath(left, leg.field)
      const key = coerceRefKey(rawId)
      const dictEntry = key === null ? undefined : dictMap.get(key)
      out.push({ ...(left as Record<string, unknown>), [leg.as]: dictEntry ?? null })
    }
    return out
  }

  const source = context.resolveSource(leg.target)
  if (!source) {
    throw new Error(
      `.join() cannot resolve target collection "${leg.target}" ` +
        `(referenced from field "${leg.field}" on "${context.leftCollection}"). ` +
        `Make sure the target collection has been opened via vault.collection() ` +
        `at least once before running the query.`,
    )
  }

  const maxRows = leg.maxRows ?? DEFAULT_JOIN_MAX_ROWS

  // Per-leg left-side ceiling check (#75 acceptance #3). In a
  // multi-FK chain, each leg's `maxRows` is enforced independently
  // against the current left-row count, so
  // `.join('a', { maxRows: 100_000 }).join('b', { maxRows: 50 })`
  // correctly throws on the second leg if the left set exceeds 50.
  if (leftRows.length > maxRows) {
    throw new JoinTooLargeError({
      leftRows: leftRows.length,
      rightRows: -1,
      maxRows,
      side: 'left',
      message:
        `.join() left side has ${leftRows.length} rows, exceeding the ${maxRows}-row ` +
        `ceiling for target "${leg.target}". Filter the left side further with ` +
        `where()/limit() before joining, or raise the ceiling via { maxRows }. ` +
        `Streaming joins over scan() are tracked in #76.`,
    })
  }
  if (leftRows.length > maxRows * JOIN_WARN_FRACTION) {
    warnCeilingApproaching(leg.target, 'left', leftRows.length, maxRows)
  }

  const rightSnapshot = source.snapshot()
  if (rightSnapshot.length > maxRows) {
    throw new JoinTooLargeError({
      leftRows: leftRows.length,
      rightRows: rightSnapshot.length,
      maxRows,
      side: 'right',
      message:
        `.join() right side "${leg.target}" has ${rightSnapshot.length} rows, ` +
        `exceeding the ${maxRows}-row ceiling. Raise the ceiling via { maxRows } ` +
        `if the data genuinely fits in memory, or track #76 for streaming joins.`,
    })
  }
  if (rightSnapshot.length > maxRows * JOIN_WARN_FRACTION) {
    warnCeilingApproaching(leg.target, 'right', rightSnapshot.length, maxRows)
  }

  // Strategy selection: explicit override wins; otherwise prefer
  // nested-loop when the source exposes lookupById (O(1) per row),
  // falling back to hash join when it doesn't.
  const strategy: JoinStrategy =
    leg.strategy ?? (source.lookupById ? 'nested' : 'hash')

  if (strategy === 'nested' && source.lookupById) {
    // Bind through an arrow so the `this` context of lookupById
    // doesn't drift — same pattern as the existing candidateRecords
    // helper in builder.ts.
    const lookup = (id: string): unknown => source.lookupById?.(id)
    return nestedLoopJoin(leftRows, leg, lookup)
  }
  return hashJoin(leftRows, leg, rightSnapshot)
}

function nestedLoopJoin(
  leftRows: readonly unknown[],
  leg: JoinLeg,
  lookupById: (id: string) => unknown,
): unknown[] {
  const out: unknown[] = []
  for (const left of leftRows) {
    const rawId = readPath(left, leg.field)
    const key = coerceRefKey(rawId)
    const right = key === null ? undefined : lookupById(key)
    out.push(attachJoin(left, leg, right, rawId))
  }
  return out
}

function hashJoin(
  leftRows: readonly unknown[],
  leg: JoinLeg,
  rightSnapshot: readonly unknown[],
): unknown[] {
  // Build the right-side hash once per query execution. We key on
  // the `id` field because ref() always points to a target's primary
  // key — non-equi and non-id joins are out of scope for v0.6.
  const rightMap = new Map<string, unknown>()
  for (const record of rightSnapshot) {
    const rawId = readPath(record, 'id')
    const key = coerceRefKey(rawId)
    if (key !== null) {
      rightMap.set(key, record)
    }
  }
  const out: unknown[] = []
  for (const left of leftRows) {
    const rawId = readPath(left, leg.field)
    const key = coerceRefKey(rawId)
    const right = key === null ? undefined : rightMap.get(key)
    out.push(attachJoin(left, leg, right, rawId))
  }
  return out
}

/**
 * Attach the resolved right-side record (or null) to the left row
 * under the alias, applying ref-mode semantics for the dangling
 * case.
 *
 * A left-side record whose FK field is null/undefined is NOT a
 * dangling ref — it's "no reference at all", which is always
 * allowed regardless of mode. This matches the write-time
 * `enforceRefsOnPut` behavior: "Nullish ref values are allowed —
 * treat them as 'no reference'."
 *
 * Only non-null FKs pointing at non-existent targets trigger the
 * mode behavior.
 */
function attachJoin(
  left: unknown,
  leg: JoinLeg,
  right: unknown,
  rawId: unknown,
): unknown {
  if (left === null || typeof left !== 'object') {
    // Pathological input — return as-is. Shouldn't happen in
    // practice because QuerySource yields objects, but defensive
    // because plan execution is untyped at this layer.
    return left
  }
  const merged: Record<string, unknown> = { ...(left as Record<string, unknown>) }

  // "No ref at all" — null/undefined FK value, or a non-string/non-
  // number FK that coerceRefKey treated as no-ref. Never throws
  // regardless of mode; matches the write-time policy that nullish
  // refs are allowed.
  const refKey = coerceRefKey(rawId)
  if (right === undefined) {
    if (refKey !== null && leg.mode === 'strict') {
      throw new DanglingReferenceError({
        field: leg.field,
        target: leg.target,
        refId: refKey,
        message:
          `.join() strict dangling: record references "${leg.target}:${refKey}" ` +
          `via field "${leg.field}", but no such record exists. Use ref() mode 'warn' ` +
          `or 'cascade' if dangling refs are acceptable, or run ` +
          `vault.checkIntegrity() to find and fix the orphans.`,
      })
    }
    if (refKey !== null && leg.mode === 'warn') {
      warnOnceDangling(leg.field, leg.target, refKey)
    }
    // For 'cascade' and null refs we attach null silently. Cascade
    // is a delete-time mode; any dangling refs visible at read time
    // are either mid-flight or pre-existing orphans, not a DSL error.
    merged[leg.as] = null
  } else {
    merged[leg.as] = right
  }
  return merged
}

/**
 * Test-only: reset the join warning deduplication state between
 * tests. Production code never calls this — the dedup state is
 * intentionally process-scoped so a noisy query doesn't spam the
 * console once per component render.
 */
export function resetJoinWarnings(): void {
  warnedDanglingKeys.clear()
  warnedCeilingKeys.clear()
}
