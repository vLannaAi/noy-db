/**
 * Query DSL `.join()` — eager, single-FK, intra-vault joins.
 *
 * resolves a ref()-declared foreign key into an attached
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
 * Scope:
 *
 *   - Equi-joins on declared `ref()` fields only. Joins on
 *     undeclared fields throw at plan time with an actionable error
 *     naming the field and collection.
 *   - Same-vault only. Cross-vault correlation goes
 *     through `queryAcross`; this is an architectural
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
 * Partition-awareness seam:
 *
 * Every `JoinLeg` carries a `partitionScope` field that is always `'all'`.
 * The executor never reads it. See {@link JoinLeg.partitionScope} for the
 * two constraints (#1342) that decide how it may ever be populated — one of
 * them silently invalidates stored materialized views.
 *
 * Joins stay OUT of the ledger: reads don't touch `_ledger/`,
 * including joined reads.
 */

import type { RefDescriptor, RefMode } from '../refs.js'
import type { Clause } from './predicate.js'
import type { ViaPipeline } from '../via/pipeline.js'
import { readPath } from './predicate.js'
import { matchDeclaredJoin, type JoinOnPlan } from './join-on.js'
import { JoinTooLargeError, DanglingReferenceError } from '../errors.js'

/** Planner strategy for a single join leg. Auto-selected unless overridden. */
export type JoinStrategy = 'hash' | 'nested'

/**
 * Which side of a join leg is preserved (#1289).
 *
 *   - `'left'`  — every left row survives, `null` under the alias when the
 *     FK resolves to nothing. This is what `.join()` has always done, and it
 *     is the default for a leg that names no direction.
 *   - `'right'` — every RIGHT record survives, including one nothing points
 *     at; a left row whose FK matches nothing is dropped.
 *   - `'full'`  — the union of the two.
 *
 * `'right'` and `'full'` are the only two that need the reverse index — see
 * {@link outerJoinFromRight}. A forward leg is driven by the left row's FK
 * and never has to ask "did anything point at this".
 */
export type JoinDirection = 'left' | 'right' | 'full'

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
 * This is the primary place the partition seam is honored: every leg carries
 * a `partitionScope` field that is always `'all'` and is never read by the
 * executor. See {@link JoinLeg.partitionScope}.
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
   * Partition scope for future partition-aware joins. Always `'all'` today —
   * the executor never reads this field. Do not remove even though it looks
   * unused: it is a plan-shape seam.
   *
   * ⛔ TWO CONSTRAINTS BEFORE POPULATING THIS (#1342):
   *
   * 1. **It is a `queryHash` input on a HAND-COMPOSED path only — NOT for a
   *    registered materialized view.** ⚠️ This paragraph asserted the
   *    opposite until 2026-09-04; the correction is the measurement.
   *    `MaterializedViewRegistry` feeds `computeQueryHash` from
   *    `summarizeQueryPlan()` (`materialized-views/registry.ts:201,243`),
   *    and that summary has never emitted `partitionScope`. `serializePlan()`
   *    *does* emit `plan.joins` verbatim, and `canonicalizeQueryPlan` is
   *    exported, so a consumer composing
   *    `computeQueryHash(name, deps, canonicalizeQueryPlan(serializePlan(q)))`
   *    by hand does carry the field in their hash. **That composition, and
   *    only that one, is what this constraint binds** — it is also the
   *    composition `__tests__/query-partition-scope.test.ts` builds, which is
   *    why the file read as evidence for the stronger claim.
   *    ⭐ So populating this field does NOT invalidate registered MVs. The
   *    reason to leave it alone is smaller and still sufficient: it is a
   *    DERIVED value — storing it buys nothing, and it is the one leg key
   *    emitted UNCONDITIONALLY rather than omitted-at-default, so any later
   *    move to summarise it (see #1389's rule) would shift every joined MV's
   *    hash at once, for zero gain. Derive the scope in the EXECUTOR from
   *    clauses the plan already carries. Pinned by
   *    `__tests__/query-partition-scope.test.ts`, which now pins BOTH paths.
   *
   * 2. **The seam-change route was RULED OUT, and the pruning shipped
   *    anyway** — ADR 0007, "partitioning is collection-shaped". Pruning only
   *    pays on the `scan()` path (`query()` runs over an in-memory,
   *    already-decrypted cache where `candidateRecords()`'s hash / sorted /
   *    compound dispatch (#1344, #1345) narrows better than a partition ever
   *    could). Buying it by teaching `NoydbStore.listPage` a filter would
   *    have meant lifting the partition key out of the ciphertext into a
   *    storage key or cleartext metadata — a permanent per-record
   *    classification handed to the backend, and a change to the published
   *    `@noy-db/hub/to` contract across every `to-*` adapter. **Ruled no.**
   *    ⭐ The pruning was bought instead with information the store already
   *    has: `listPage(vault, **collection**, …)` names the collection in
   *    cleartext, so a partition modelled as its own collection is never
   *    fetched because it is never asked for.
   *
   * ⭐ **THE SCOPE IS NOW DERIVED, IN THE EXECUTOR, AND THIS FIELD IS STILL
   * DORMANT.** `kernel/query/partition.ts`'s `resolvePartitionScope()` is the
   * one decision function — `with-store/partitioned/` and `explain()` both
   * call it — and it takes the plan's top-level clause list, never a stored
   * leg. It is sound in one direction only: narrow ONLY on a whitelist of
   * provable shapes (`==` / `in` on the declared key at the top level of the
   * AND-ed clause list), and fall back to `'all'` for everything else —
   * `or` groups, negations, callback clauses, and any Via-covered clause
   * (its operand is in STORED form, not partition-key space, which is why
   * `candidateRecords` refuses the index for it too). A partition wrongly
   * excluded is silently missing data.
   */
  readonly partitionScope: 'all' | readonly string[]
  /**
   * Which side is preserved (#1289). `undefined` reads as `'left'` — the
   * pre-#1289 behaviour — so every plan built before this field existed, and
   * every serialized plan that omits it, keeps its meaning exactly.
   */
  readonly direction?: JoinDirection
  /**
   * INNER join (#1361) — drop every left row whose alias resolves to nothing,
   * instead of attaching `null` under it.
   *
   * Only `.join()` sets it (a right/full leg already drops on its own side),
   * and only when the caller passes `{ mode: 'inner' }`. Omitted rather than
   * written as `false` for the same reason `direction` is: a plan built
   * without it must serialize byte-identically to a pre-#1361 one, or every
   * stored `queryHash` moves.
   */
  readonly inner?: true
  /**
   * A DECLARED, deterministic join predicate (#1339) — composite equality or
   * a range — instead of the `ref()`-declared FK the rest of this file
   * resolves. Set only by `.joinOn()`, always through
   * {@link normalizeJoinOn}, and OMITTED on every other leg: a plan built by
   * `.join()` must serialize byte-identically to a pre-#1339 one, or every
   * stored `queryHash` moves (the same discipline `direction` and `inner`
   * follow above).
   *
   * ⭐ This is the field that separates `.joinOn()` from `.crossJoin({ on })`.
   * It is plain JSON, so it survives `serializePlan()` and
   * `summarizeQueryPlan()` and a materialized view can therefore DEPEND on
   * it. A closure cannot. See `join-on.ts`.
   */
  readonly on?: JoinOnPlan
  /**
   * When `true`, this is a dictionary join. The executor
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
 * The optional `subscribe` is used by `Query.live()` to merge
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
   * Default locale a label-resolving query falls back to when the query
   * itself is locale-less. Set by a `staticDict()`-backed source from its
   * `displayLocale` so `{ by: 'label' }` resolves under a locale-less read.
   * Plain `_dict_*`-backed sources omit it.
   */
  readonly displayLocale?: string
  /**
   * Sync present-for-join dressing (#626 retirement, #650 Task 6) — when
   * present and the query carries a locale, each joined right-side record
   * is passed through this hook (built by the right-side `Collection` from
   * its own i18n-text + lookup-label bindings) BEFORE it is attached under
   * the leg's alias — so a joined `i18nText` field resolves to a string
   * (not a raw `{ locale }` map) and a joined lookup field gains its
   * `<field>Label`. Locale-less queries leave joined fields raw
   * (consistent with a locale-less read). Replaces the old `i18nFields`
   * data field — the join executor no longer resolves i18n locale itself,
   * it just calls this hook.
   */
  readonly presentForJoin?: (record: unknown, locale: string) => unknown
  /**
   * The id-paired view of {@link snapshot} (#1289).
   *
   * ⚠️ A `Collection` snapshot record does NOT carry its own id — the id is
   * the cache key, not a field. The forward join never noticed, because it
   * reads the id off the LEFT row's FK and calls `lookupById`. A right/full
   * outer join has to ask each RIGHT record "what is your id, and did
   * anything point at you", and there is no field to read it from.
   *
   * Optional so a plain-object test source stays valid; `outerJoinFromRight`
   * falls back to an `id` FIELD on the record, which is what such sources
   * carry. A real Collection supplies this and the fallback never runs.
   */
  snapshotEntries?(): readonly { readonly id: string; readonly record: unknown }[]
  /**
   * Via RESULT decode for this source's own records (#1289) — the same
   * `via.decodeResults` a top-level `toArray()` applies (money's stored
   * scaled-int → canonical decimal, etc.).
   *
   * It exists because Via dressing keys by BARE FIELD NAME: the moment a
   * record moves under an alias (`{ client: { amount } }`, or both sides of
   * `crossJoinWith`) the top-level decode cannot see it, and the row silently
   * serves raw money. Distinct from `presentForJoin`, which is the LOCALE
   * half (i18n text + lookup labels) and only runs for a locale-carrying
   * query — this half is locale-free and always applies.
   */
  readonly decodeResults?: (record: unknown) => unknown
  /**
   * This source's own compiled Via pipeline (#1337 / #1338).
   *
   * The two halves above (`presentForJoin`, `decodeResults`) dress a record
   * that is ON ITS WAY OUT. Ordering, grouping and reduction happen while it
   * is still under an alias mid-plan, and they need the pipeline itself:
   * `compareForOrder` to sort an aliased money field by MAGNITUDE rather than
   * lexically over its stored scaled integer, and `wrapReducers` to rewrite
   * `sum('client.credit')` into the exact-BigInt money reducer (which also
   * applies the RIGHT collection's `queryable: 'none'` posture gate — the
   * gate whose silent absence is why joined aggregation was refused).
   *
   * A THUNK, not a property: `_applyMoneyFields` can rebuild a collection's
   * pipeline after this source object has been handed out, and a copied
   * reference would go quietly stale — the same discipline `decodeResults`
   * above already follows.
   *
   * Optional: a plain-object test source declares none, and every consumer
   * treats absence as "no binding covers anything here".
   */
  readonly via?: () => ViaPipeline | undefined
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
  /**
   * The owning collection's default locale. Used to resolve joined
   * i18n fields at the `join` layer when a terminal call doesn't pass an
   * explicit locale — so `openVault({ locale })` flows to joins like it does
   * to `get`/`list`. A per-call `toArray({ locale })` overrides it.
   */
  readonly defaultLocale?: string
  /** Look up a `RefDescriptor` by field name on the left collection. */
  resolveRef(field: string): RefDescriptor | null
  /** Resolve a right-side source by target collection name. */
  resolveSource(collectionName: string): JoinableSource | null
  /**
   * Resolve a dictKey join source. Returns a `JoinableSource`
   * whose snapshot exposes `{ key, ...labels }` records, keyed by the
   * stable dictionary key. `null` when the field is not a dictKey.
   *
   * The source is built from the compartment's in-memory dictionary
   * snapshot — same data as `DictionaryHandle.list()`, O(1) per lookup.
   */
  resolveDictSource?(field: string): JoinableSource | null
}

/**
 * Does this clause address a field that only exists once join legs are
 * attached — i.e. is its path rooted at a join alias?
 *
 * Only `FieldClause` is inspectable. A `FilterClause` carries an opaque
 * function and a `WherePredicateClause` a named one, so neither can be
 * classified; both stay on the pre-join side, which is where they have
 * always run. See `splitAroundJoins`.
 */
function referencesJoinAlias(clause: Clause, aliases: ReadonlySet<string>): boolean {
  if (clause.type !== 'field') return false
  // `where('client.name', …)` addresses the alias; so does the anti-join
  // form `where('client', '==', null)`, where the path IS the alias.
  return aliases.has(clause.field.split('.')[0]!)
}

/**
 * Split a plan's clauses into those evaluable before the join legs run and
 * those that need the joined shape (#1030).
 *
 * Join legs attach after `where` so the left set can be narrowed (and
 * index-driven) first. That is the right default, but it silently broke any
 * predicate addressing a joined alias: the field did not exist yet, so
 * `readPath` returned `undefined`, nothing matched, and the query returned an
 * empty result with no error.
 *
 * The split is deliberately narrow. When no clause addresses an alias — every
 * query written against the previous behaviour — `postJoin` is empty and the
 * caller takes its original path unchanged. The reordered pipeline therefore
 * only ever runs for queries that match nothing today.
 *
 * KNOWN RESIDUAL: `.filter(r => r.client?.name === 'Ann')` cannot be
 * classified (the predicate is a closure), so it still runs pre-join and still
 * sees no alias. Prefer `.where()` for anything addressing a joined field.
 *
 * Shared by the eager `Query` and the streaming `ScanBuilder` so the two
 * cannot drift on which side a clause belongs to.
 */
export function splitAroundJoins(
  clauses: readonly Clause[],
  joins: readonly JoinLeg[],
): { readonly preJoin: readonly Clause[]; readonly postJoin: readonly Clause[] } {
  if (joins.length === 0 || clauses.length === 0) return { preJoin: clauses, postJoin: [] }
  const aliases = new Set(joins.map(leg => leg.as))
  const preJoin: Clause[] = []
  const postJoin: Clause[] = []
  for (const clause of clauses) {
    ;(referencesJoinAlias(clause, aliases) ? postJoin : preJoin).push(clause)
  }
  return { preJoin, postJoin }
}

/**
 * Does any `orderBy` entry address a field that only exists once the legs are
 * attached (#1337)?
 *
 * The ordering half of {@link splitAroundJoins}, kept beside it because the
 * two answer the same question about different parts of the plan, and because
 * `Query.toArray()` and `Query.explain()` must not drift on the answer — one
 * decides when the sort runs, the other reports it.
 *
 * ⚠️ Only `plan.joins` legs count. A `crossJoin` alias lives in the CLAUSE
 * list and its expansion already runs before ordering, so an ordering over
 * one has never needed moving.
 */
export function orderReferencesJoinAlias(
  orderBy: readonly { readonly field: string }[],
  joins: readonly JoinLeg[],
): boolean {
  if (joins.length === 0 || orderBy.length === 0) return false
  const aliases = new Set(joins.map(leg => leg.as))
  return orderBy.some(entry => aliases.has(entry.field.split('.')[0]!))
}

/**
 * Does any leg drop left rows (#1361)?
 *
 * The entry condition for every terminal that must run the legs even though
 * nothing addresses an alias: an inner leg is no longer projection-only, so
 * `count()`, `exists()` and the ordering placement in `toArray()` all have to
 * ask. Kept beside {@link splitAroundJoins} and {@link orderReferencesJoinAlias}
 * because the three answer the same family of question, and because
 * `Query.toArray()` and `Query.explain()` must not drift on the answer.
 */
export function joinsDropLeftRows(joins: readonly JoinLeg[]): boolean {
  return joins.some(leg => leg.inner === true)
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
export function coerceRefKey(value: unknown): string | null {
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
      `scan() are not yet supported for collections that need to exceed this.`,
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
 * **Ordering:** joins run AFTER orderBy / limit / offset by DEFAULT, so
 * "top 10 invoices with client" sorts and paginates the left side first
 * (index-driven) and joins only the page. Two things flip that, and both
 * are decided by the plan, never by a flag: a `where` addressing an alias
 * (#1030, {@link splitAroundJoins}) and an `orderBy` addressing one (#1337,
 * {@link orderReferencesJoinAlias}). Either one moves the sort and the page
 * to AFTER the legs, because neither can be evaluated against a row where
 * the alias does not exist yet. ⚠️ That query necessarily loses the
 * index-driven ordering fast path — the cost of sorting on a field the
 * index does not hold. `Query.explain()` names which placement a plan gets.
 *
 * An INNER leg (#1361) moves only the PAGE, not the sort: the drop removes
 * rows, so `limit` must observe it, but the ordering is on a left-side field
 * that the drop cannot reorder. `toArray()` therefore sorts pre-join, joins,
 * and slices after — and `explain()` reports `pre-join` on the sort and
 * `post-join` on the page rather than one word for both.
 *
 * **Multi-FK chaining:** each leg's `maxRows` is enforced
 * against the current left-row count independently. Because
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
  locale?: string,
): unknown[] {
  if (joins.length === 0) return [...rows]

  let result: unknown[] = [...rows]
  for (const leg of joins) {
    result = applyOneJoin(result, leg, context, locale)
  }
  return result
}

/**
 * One leg, plus the #1361 inner-join drop.
 *
 * The drop is applied to the leg's OUTPUT rather than threaded through the
 * three producers (nested-loop, hash, dict) — an unmatched row is `null` under
 * the alias in all three by construction, and `attachJoin` has already run, so
 * a strict-mode `DanglingReferenceError` still fires for a dangling ref that
 * `inner` would otherwise hide.
 */
function applyOneJoin(
  leftRows: readonly unknown[],
  leg: JoinLeg,
  context: JoinContext,
  locale?: string,
): unknown[] {
  const rows = applyOneJoinRaw(leftRows, leg, context, locale)
  if (leg.inner !== true) return rows
  return rows.filter(row => row !== null && typeof row === 'object' && (row as Record<string, unknown>)[leg.as] != null)
}

function applyOneJoinRaw(
  leftRows: readonly unknown[],
  leg: JoinLeg,
  context: JoinContext,
  locale?: string,
): unknown[] {
  // Dict join path — resolve left-field value against the
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

  // Per-leg left-side ceiling check. In a
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
        `Streaming joins over scan() are not yet supported.`,
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
        `if the data genuinely fits in memory, or track  for streaming joins.`,
    })
  }
  if (rightSnapshot.length > maxRows * JOIN_WARN_FRACTION) {
    warnCeilingApproaching(leg.target, 'right', rightSnapshot.length, maxRows)
  }

  // `join`-layer dressing (#650 Task 6, #626 retirement). When the query
  // carries a locale (per-call or the owning collection's default) and the
  // right side declares a `presentForJoin` hook, resolve each matched right
  // record through it before it's attached. Locale-less → leave raw.
  const effLocale = locale ?? context.defaultLocale
  const presentResolve: ((right: unknown) => unknown) | undefined =
    effLocale !== undefined && source.presentForJoin !== undefined
      ? (right) =>
          right !== null && typeof right === 'object'
            ? source.presentForJoin!(right, effLocale)
            : right
      : undefined

  // #1339 — a declared `on` replaces the FK lookup entirely: there is no
  // ref, so neither `lookupById` nor the id-keyed hash means anything. It
  // runs BEFORE the strategy/direction selection below because it answers
  // both questions itself (see `join-on.ts` for which strategy serves which
  // shape, and at what cost).
  if (leg.on !== undefined) {
    return declaredJoin(leftRows, leg, leg.on, rightSnapshot, maxRows, presentResolve)
  }

  // Strategy selection: explicit override wins; otherwise prefer
  // nested-loop when the source exposes lookupById (O(1) per row),
  // falling back to hash join when it doesn't.
  const strategy: JoinStrategy =
    leg.strategy ?? (source.lookupById ? 'nested' : 'hash')

  // #1289 — a right/full outer join cannot be driven by the left row's FK,
  // because the rows it must produce are exactly the ones no FK names. It
  // reverses the index instead: bucket the LEFT rows by their FK value, then
  // walk the right snapshot asking each record "did anything point at me".
  const direction = leg.direction ?? 'left'
  if (direction !== 'left') {
    return outerJoinFromRight(leftRows, leg, source, direction, presentResolve)
  }

  if (strategy === 'nested' && source.lookupById) {
    // Bind through an arrow so the `this` context of lookupById
    // doesn't drift — same pattern as the existing candidateRecords
    // helper in builder.ts.
    const lookup = (id: string): unknown => source.lookupById?.(id)
    return nestedLoopJoin(leftRows, leg, lookup, presentResolve)
  }
  return hashJoin(leftRows, leg, rightSnapshot, presentResolve)
}

/**
 * Execute a declared-`on` leg (#1339).
 *
 * The match set comes from `join-on.ts`; this function is only the part that
 * has to agree with the rest of `.join()` — the alias attachment, the
 * present/decode dressing, and the OUTPUT ceiling.
 *
 * ⚠️ The output ceiling is not redundant with the two side ceilings above. A
 * ref join is one-to-one, so `output === leftRows`; a declared join is
 * many-to-many, so 1,000 × 1,000 rows both comfortably under a 50,000-row
 * side ceiling can produce a million rows. Checking as rows are produced is
 * what makes an unbounded theta join an error rather than a hang.
 */
function declaredJoin(
  leftRows: readonly unknown[],
  leg: JoinLeg,
  on: JoinOnPlan,
  rightSnapshot: readonly unknown[],
  maxRows: number,
  presentResolve?: (right: unknown) => unknown,
): unknown[] {
  const matches = matchDeclaredJoin(leftRows, on, rightSnapshot, maxRows, produced => {
    throw new JoinTooLargeError({
      leftRows: leftRows.length,
      rightRows: rightSnapshot.length,
      maxRows,
      side: 'output',
      message:
        `.joinOn("${leg.target}") produced more than ${maxRows} rows (${produced} and counting) from ` +
        `${leftRows.length} left x ${rightSnapshot.length} right. A declared \`on\` is many-to-many, so ` +
        `the per-side ceilings do not bound the result. Narrow the predicate, filter the left side ` +
        `with where()/limit() before joining, or raise the ceiling via { maxRows }.`,
    })
  })
  const out: unknown[] = []
  for (const { left, right } of matches) {
    const dressed = presentResolve && right !== undefined ? presentResolve(right) : right
    // `rawId` is `undefined` on purpose: a declared join has no ref, so
    // "matched nothing" is never a DANGLING ref — `attachJoin` reads a null
    // key as "no reference at all" and attaches null without consulting the
    // ref mode. An unmatched row is data, not corruption.
    out.push(attachJoin(left, leg, dressed, undefined))
  }
  return out
}

function nestedLoopJoin(
  leftRows: readonly unknown[],
  leg: JoinLeg,
  lookupById: (id: string) => unknown,
  presentResolve?: (right: unknown) => unknown,
): unknown[] {
  const out: unknown[] = []
  for (const left of leftRows) {
    const rawId = readPath(left, leg.field)
    const key = coerceRefKey(rawId)
    let right = key === null ? undefined : lookupById(key)
    if (presentResolve && right !== undefined) right = presentResolve(right)
    out.push(attachJoin(left, leg, right, rawId))
  }
  return out
}

function hashJoin(
  leftRows: readonly unknown[],
  leg: JoinLeg,
  rightSnapshot: readonly unknown[],
  presentResolve?: (right: unknown) => unknown,
): unknown[] {
  // Build the right-side hash once per query execution. We key on
  // the `id` field because ref() always points to a target's primary
  // key — non-equi and non-id joins are out of scope for.
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
    let right = key === null ? undefined : rightMap.get(key)
    if (presentResolve && right !== undefined) right = presentResolve(right)
    out.push(attachJoin(left, leg, right, rawId))
  }
  return out
}

/**
 * Bucket the left rows by the FK value they carry, so the right side can be
 * asked "did anything point at this record" in O(1).
 *
 * This IS the reverse index #1289 names. It is built per execution and lives
 * only for the length of the join: nothing is persisted, no store is touched,
 * and it costs one pass over the left set that the forward path does not pay.
 * Left rows with a null/uncoercible FK are absent from every bucket — they are
 * "no reference at all", never a match.
 */
function reverseIndex(leftRows: readonly unknown[], field: string): Map<string, unknown[]> {
  return bucketByRefKey(leftRows, left => readPath(left, field))
}

/**
 * The reverse-FK index, generalised over what sits in the bucket (#1352).
 *
 * `outerJoinFromRight` buckets bare left ROWS by their FK; `traverse()`
 * buckets id-paired ENTRIES, because a child row alone cannot say what its
 * own id is (a Collection snapshot record carries no `id` field — the id is
 * the cache key). Same question — "who points at this?" — same coercion
 * rules, so it is deliberately one implementation rather than two that can
 * drift on what counts as a usable FK value.
 *
 * `readKey` extracts the raw FK from an item; `coerceRefKey` then decides
 * whether it is a key at all. An item whose FK is nullish, or is neither a
 * string nor a number, is dropped — "no reference", not "a reference to
 * `[object Object]`".
 */
export function bucketByRefKey<V>(
  items: readonly V[],
  readKey: (item: V) => unknown,
): Map<string, V[]> {
  const buckets = new Map<string, V[]>()
  for (const item of items) {
    const key = coerceRefKey(readKey(item))
    if (key === null) continue
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }
  return buckets
}

/**
 * Right / full outer join (#1289).
 *
 * Walks the RIGHT snapshot as the driving relation. A right record with a
 * non-empty bucket emits one row per left row in it (identical in shape to
 * what the forward path would have produced); a right record nothing points
 * at emits a LEFT-LESS row — `{ [leg.as]: right }` and nothing else, which is
 * SQL's "the left columns are NULL" rendered in an object language.
 *
 * `'full'` then appends the left rows the right side never claimed, in their
 * original order, with `null` under the alias — i.e. exactly the rows the
 * forward left-outer path would emit for them, ref-mode behaviour included.
 * `'right'` drops those rows, but still runs the ref-mode check on them: a
 * strict dangling ref is a data-integrity finding, and hiding it behind a
 * change of join direction would make corruption depend on which method the
 * caller happened to type.
 */
function outerJoinFromRight(
  leftRows: readonly unknown[],
  leg: JoinLeg,
  source: JoinableSource,
  direction: JoinDirection,
  presentResolve?: (right: unknown) => unknown,
): unknown[] {
  const byRight = reverseIndex(leftRows, leg.field)
  const matchedLeft = new Set<unknown>()
  const out: unknown[] = []

  // Prefer the id-paired view: a Collection record has no `id` field, so
  // reading one off the record would leave every bucket unmatched and turn a
  // right join into "every right record is an orphan" — wrong, and quietly so
  // in `cascade`/`warn` mode. The field fallback serves plain-object sources.
  const entries: readonly { id: string | null; record: unknown }[] =
    source.snapshotEntries?.() ??
    source.snapshot().map(record => ({ id: coerceRefKey(readPath(record, 'id')), record }))

  for (const { id: rid, record: right } of entries) {
    const dressed = presentResolve ? presentResolve(right) : right
    const bucket = rid === null ? undefined : byRight.get(rid)
    if (bucket === undefined || bucket.length === 0) {
      // Nothing points at this record — the row that only a right/full outer
      // join can produce.
      out.push({ [leg.as]: dressed })
      continue
    }
    for (const left of bucket) {
      matchedLeft.add(left)
      out.push(attachJoin(left, leg, dressed, readPath(left, leg.field)))
    }
  }

  for (const left of leftRows) {
    if (matchedLeft.has(left)) continue
    // Unmatched left row: `attachJoin` with an undefined right applies the
    // ref mode (strict throws, warn warns once) and attaches null.
    const row = attachJoin(left, leg, undefined, readPath(left, leg.field))
    if (direction === 'full') out.push(row)
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
