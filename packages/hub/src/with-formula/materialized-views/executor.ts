import { groupKeyName, isDateTruncKey, projectDateTruncKeys, type GroupKey } from '../../kernel/query/reduce/date-trunc.js'
import type { Collection } from '../../kernel/collection.js'
import type { TxContext } from '../../with-commit/tx/transaction.js'
import type { EncryptedEnvelope } from '../../kernel/types.js'
import { MaterializedViewTooLargeError, MaterializedViewConfigError, LocaleNotSpecifiedError, JoinTooLargeError } from '../../kernel/errors.js'
import { DEFAULT_JOIN_MAX_ROWS } from '../../kernel/query/relate/join.js'
import type { MaterializedFromMeta, MVQueryContext, MaterializedViewSpec, ProjectionJoinLeg } from './types.js'
import type { RegisteredMV } from './registry.js'
import { wrapDbWithPredicates, ungatedMvContext } from './registry.js'
import { groupAndReduce } from '../../with-lookup/reduce/groupby.js'
import { canonicalGroupKey } from '../../with-lookup/reduce/canonical-key.js'
import { applyI18nLocale, type I18nTextDescriptor } from '../../via/i18n/core.js'
import { canonicalizeMoneyFieldsAsDecimal, decodeMoneyFields } from '../../via/money/normalize.js'
import { exactMath } from '../../via/money/exact.js'
import { putDerivedOutput, type PutDerivedOutputCtx } from '../../kernel/via/dispatch.js'
import { isCollectLeg, resolveLegOwner, type RefLookup } from './projection-legs.js' // #1140
import { emitMemoKey, readEmitMemo, writeEmitMemo, rowContentKey } from './emit-memo.js' // #1418

/**
 * Accessor shape passed in from the owning Vault. Mirrors v1's
 * `DerivationStaleAccessor` — provides the per-collection resolver
 * and the active TxContext so refresh writes/tombstones register on
 * `_executed` for rollback symmetry.
 */
export interface MVExecutorAccessor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCollection(name: string): Collection<any>
  getActiveTxContext(): TxContext | null
  /**
   * Vault-shaped accessor passed to the MV's `query()` callback at
   * each refresh. Same instance the registry used at registration
   * time; threading through the executor lets the refresh path
   * re-evaluate the closure against the live vault state.
   */
  getQueryContext(): MVQueryContext
  /**
   * #638 Task 5 — ctx for `putDerivedOutput`'s frozen-period skip+audit. #641: the lazy
   * resolve-on-read caller (`stale.ts#resolveStaleMVOnRead`) now supplies one too — built at
   * the `Collection.get()`/`list()` entry point with a `'resolve-on-read'` sentinel id (no
   * real "reacting write" for a read-triggered materialize, mirroring `refreshView()`'s
   * `'refreshView'` sentinel). Still declared optional here since `MVExecutorAccessor` is a
   * general shape and a future caller could reasonably omit it.
   */
  dispatchCtx?: PutDerivedOutputCtx
}

export interface RefreshResult {
  /** Rows newly written / overwritten. */
  written: number
  /**
   * #1418 — rows whose content was byte-identical to what this MV last wrote,
   * so the encrypt-and-store round trip was skipped. Counted separately from
   * `written` on purpose: `written` means "a row was persisted", and reporting
   * a skip as a write would make the two indistinguishable to anyone
   * diagnosing whether a refresh actually did anything.
   */
  skipped: number
  /** Rows tombstoned via `_internalDelete` (only when `onEmpty: 'delete'`). */
  deleted: number
  /** Failed row writes (non-strict mode). */
  failed: number
  /** #782/#785 — `outputCollection:id` entries from the tombstone pass whose ownership stamp
   *  couldn't be decoded under the collection's default DEK (undecodable, mirroring
   *  `invalidateMVAtRest`'s #776 posture) — ownership UNCONFIRMED. Only populated when
   *  `onEmpty: 'delete'`. */
  residueUndecodable: string[]
  /** #782/#785 — `outputCollection:id` entries that decoded, stamp-matched this MV, but
   *  `_internalDelete` declined (the #718 tier-elevation gate) — ownership CONFIRMED, a real
   *  silent survival, surfaced rather than dropped. Only populated when `onEmpty: 'delete'`. */
  residueDeclined: string[]
}

/** Default cost ceiling — overridable per-MV via `spec.maxRows`. */
const DEFAULT_MAX_ROWS = 100_000

/**
 * Materialize a query terminal that may be a `Query<T>` (call
 * `.toArray()`), an `Reduction<R>` (call `.run()` returning a
 * single object — wrap as a one-row array), or a `GroupedReduction<R>`
 * (call `.run()` returning an array of grouped rows). Branches on
 * available terminal at runtime — no type-discrimination at registration.
 */
async function materializeQueryResult(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q: any,
  mvName: string,
  i18nLocale?: string,
  i18nFields?: Record<string, I18nTextDescriptor>,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  if (typeof q?.toArray === 'function') {
    // Query<T> — non-aggregate path. `.toArray()` returns Promise<T[]>.
    return await q.toArray()
  }
  if (typeof q?.run === 'function') {
    // Reduction<R> or GroupedReduction<R>. `.run()` is synchronous
    // and returns either a single object (Reduction) or an array of
    // rows (GroupedReduction). Promise.resolve() normalizes both
    // sync and async (future) variants.
    // Query-form MV grouping: when the MV declares i18nLocale, pass it +
    // i18nFields so a GroupedReduction resolves i18n group keys before
    // bucketing (the Reduction path ignores the extra arg).
    const runOpts = i18nLocale !== undefined ? { locale: i18nLocale, i18nFields } : undefined
    const result: unknown = await Promise.resolve(q.run(runOpts))
    if (Array.isArray(result)) {
      return result as ReadonlyArray<Record<string, unknown>>
    }
    // Single-aggregate result — wrap as one-row array. The consumer's
    // `rowKey()` should return a stable identity (often a literal
    // constant like `'total'`) since there's only one row.
    return [result as Record<string, unknown>]
  }
  throw new Error(
    `MV "${mvName}": query() must return a Query<T>, Reduction, or GroupedReduction. ` +
      `Got something without a .toArray() or .run() terminal.`,
  )
}

/**
 * Materialize a UNION-form MV: read every arm's source
 * collection, apply each arm's `map` to project rows into the unified
 * MV row shape, concatenate the mapped streams, then optionally run
 * `groupBy` + `aggregate` over the result.
 *
 * Modes (driven by `spec.groupBy` / `spec.aggregate`):
 *
 *   - No `groupBy` → return the concatenated mapped rows unchanged.
 *   - `groupBy` without `aggregate` → dedupe by composite group key,
 *     keep the first row seen per key (later arms don't overwrite
 *     earlier arms — Map insertion order rules).
 *   - `groupBy` + `aggregate` → delegate to the shared `groupAndReduce`
 *     pipeline used by `Query.groupBy().aggregate()`.
 *
 * Per-arm `map` is the schema-unification boundary; the strategy's
 * `TRow` type parameter enforces that every arm projects into the
 * same shape at compile time.
 *
 * @internal
 */
async function materializeUnionResult<TRow extends Record<string, unknown>>(
  spec: MaterializedViewSpec<TRow>,
  db: MVQueryContext,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const unified: TRow[] = []
  for (const arm of spec.unionSources!) {
    const coll = db.collection<Record<string, unknown>>(arm.collection)
    // Optional per-arm FK joins: chain `.join(field, { as, ... })` for
    // each declared leg before terminating. The aliased right-side
    // record lands at `sourceRow[leg.as]`, where the arm's `map` reads
    // it. Cast to `any` because the chained join widens the row type but
    // the executor treats every row as `Record<string, unknown>` — same
    // pattern the query-form join path uses.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = coll.query()
    if (arm.join?.length) {
      for (const leg of arm.join) {
        // #1411 — a declared leg is `Query.joinOn()`; a ref leg is `Query.join()`.
        q = 'on' in leg
          ? q.joinOn(leg.target, { as: leg.as, on: leg.on, mode: leg.mode, maxRows: leg.maxRows })
          : q.join(leg.field, { as: leg.as, maxRows: leg.maxRows, strategy: leg.strategy })
      }
    }
    const sourceRows = q.toArray() as ReadonlyArray<Record<string, unknown>>
    for (const r of sourceRows) {
      const mapped = arm.map(r)
      // null / undefined means "omit this source row" — skip without
      // pushing so groupBy/aggregate never see a null entry.
      if (mapped == null) continue
      unified.push(mapped)
    }
  }

  return finalizeMappedRows(spec, unified)
}

/**
 * Shared post-map tail for the UNION and projection (#810) forms:
 * optional `groupBy` (+ `aggregate`) over the mapped-row stream.
 * Extracted verbatim from `materializeUnionResult` so both forms feed
 * the identical grouping pipeline — i18n group-key resolution, the
 * object-group-key guard, dedup-without-aggregate, and the shared
 * `groupAndReduce` delegate.
 *
 * @internal
 */
function finalizeMappedRows<TRow extends Record<string, unknown>>(
  spec: MaterializedViewSpec<TRow>,
  unified: TRow[],
): ReadonlyArray<Record<string, unknown>> {
  if (!spec.groupBy) return unified

  const groupKeys: readonly GroupKey[] = Array.isArray(spec.groupBy)
    ? (spec.groupBy as readonly GroupKey[])
    : [spec.groupBy as GroupKey]
  const groupFields: readonly string[] = groupKeys.map(groupKeyName)

  // Derived calendar keys (#1350) are bucketed onto the mapped row first, so
  // every rule below — the i18n resolution, the object-key refusal, the dedup
  // path and `groupAndReduce` — sees an ordinary stored field.
  const derivedKeys = groupKeys.filter(isDateTruncKey)
  if (derivedKeys.length > 0) {
    unified = projectDateTruncKeys(unified, derivedKeys)
  }

  // i18n-aware group keys. An `i18nText` group field carries a raw
  // `{ locale: string }` map, an unstable object key. When `i18nLocale` is
  // declared (with `i18nFields` describing those fields), resolve the declared
  // group-key i18n fields to it at the `mv` layer FIRST — the same unified-rows
  // boundary where money is threaded — so buckets are stable strings and the
  // `mv`-layer `onMissing` policy fires here.
  if (spec.i18nLocale !== undefined && spec.i18nFields !== undefined) {
    const groupI18n: Record<string, I18nTextDescriptor> = {}
    for (const f of groupFields) {
      const d = spec.i18nFields[f]
      if (d !== undefined) groupI18n[f] = d
    }
    if (Object.keys(groupI18n).length > 0) {
      for (let i = 0; i < unified.length; i++) {
        unified[i] = applyI18nLocale(unified[i] as Record<string, unknown>, groupI18n, spec.i18nLocale, undefined, 'mv') as TRow
      }
    }
  }
  // Guard (always): a remaining object-valued group key — an undeclared i18n
  // field or a locale-less MV — would bucket on a map. Refuse, don't bucket wrong.
  for (const f of groupFields) {
    for (const row of unified) {
      const v = (row as Record<string, unknown>)[f]
      if (v !== null && typeof v === 'object') {
        throw new LocaleNotSpecifiedError(
          f,
          `Materialized view "${spec.name}" groups by "${f}", whose value is a raw i18n locale map — ` +
            `an unstable object group key. Declare { i18nLocale, i18nFields } on the MV to resolve it at ` +
            `the 'mv' layer, or group by a dictKey/staticDict code (the stable key) and resolve the label at read time.`,
        )
      }
    }
  }

  // groupBy without aggregate — dedupe by composite key, keep first
  // seen row per key. Useful for cross-arm uniqueness (e.g. unify two
  // sibling collections, keeping one row per natural key).
  if (!spec.aggregate) {
    const seen = new Map<string, TRow>()
    for (const row of unified) {
      const k = canonicalGroupKey(groupFields, row as Record<string, unknown>)
      if (!seen.has(k)) seen.set(k, row)
    }
    return [...seen.values()]
  }

  // groupBy + aggregate — delegate to the shared pipeline used by
  // `Query.groupBy().aggregate()`. Result rows carry each grouped
  // field in declaration order followed by the spec's reducer outputs.
  return groupAndReduce<Record<string, unknown>>(unified, groupFields, spec.aggregate, spec.moneyFields)
}

/**
 * Apply the spec's `derive` to each finished row (#1007).
 *
 * Three rules, all of them about keeping the hook narrow enough that the
 * engine never has to reason about the function:
 *
 *  - a `null` / `undefined` return leaves the row untouched;
 *  - a returned key that collides with a `groupBy` field is refused — group
 *    keys are the row's identity and feed `rowKey`, so letting `derive`
 *    rewrite one would silently re-home the row into a different bucket than
 *    the one it was aggregated for;
 *  - a derived field declared in `moneyFields` is quantised through its
 *    descriptor, so the stored value is exact at the declared scale instead of
 *    whatever the user's arithmetic produced.
 *
 * @internal
 */
function applyDerive<TRow extends Record<string, unknown>>(
  spec: MaterializedViewSpec<TRow>,
  rows: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> {
  const groupFields = new Set<string>(
    spec.groupBy === undefined
      ? []
      : (Array.isArray(spec.groupBy) ? spec.groupBy : [spec.groupBy]).map(groupKeyName),
  )
  return rows.map((row) => {
    // `derive` sees the row the way a READER would: money decoded to its
    // canonical decimal form, not the scaled integer the reducer left behind.
    // Handing over `1005` where the schema says `10.05` would make every
    // derived money expression quietly wrong by a factor of the scale.
    // `'raw'` keeps it at the exact decimal rather than a locale-formatted
    // string, which is what `exact.*` consumes.
    const view = spec.moneyFields ? decodeMoneyFields(row, spec.moneyFields, 'raw') : row
    const patch = spec.derive!(view as TRow, exactMath)
    if (patch === null || patch === undefined) return row
    for (const key of Object.keys(patch)) {
      if (groupFields.has(key)) {
        throw new MaterializedViewConfigError(
          `Materialized view "${spec.name}": derive() returned the group key "${key}". ` +
            'A group key is the row\'s identity and feeds rowKey — rewriting it would re-home the ' +
            'row into a bucket it was not aggregated for. Emit a differently-named field instead.',
        )
      }
    }
    // Canonicalize the PATCH only, into the DECIMAL form the money-aware
    // reducers emit — not the scaled-integer storage form a collection uses.
    // An MV row's money fields are decimal strings, so a derived field
    // quantised into storage form reads back as the scaled integer beside
    // correctly-decoded siblings: `"1000000"` next to `"10000.00"` (#1018).
    // Precision is still enforced; only the output shape differs.
    const canonical = spec.moneyFields
      ? canonicalizeMoneyFieldsAsDecimal(patch, spec.moneyFields)
      : patch
    return { ...row, ...canonical }
  })
}

/**
 * Materialize a projection-form MV (#810): hydrate the primary source
 * rows, resolve forward FK legs through the same `.join()` machinery
 * the UNION arms use, attach reverse "collect" legs via one
 * hash-grouped snapshot pass per leg, then run the projection `map`
 * (null / undefined omits the primary row) and the shared post-map
 * grouping tail.
 *
 * @internal
 */
async function materializeProjectionResult<TRow extends Record<string, unknown>>(
  spec: MaterializedViewSpec<TRow>,
  db: MVQueryContext,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const projection = spec.projection!
  const coll = db.collection<Record<string, unknown>>(projection.source)
  // ROOT forward legs chain through the query builder exactly like UNION arm
  // joins — ref() resolution, dangling-mode semantics, presentation dressing,
  // and ceilings all ride the existing `.join()` path. Cast to `any` for the
  // same reason `materializeUnionResult` does.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = coll.query()
  for (const leg of projection.joins) {
    if (isCollectLeg(leg) || leg.from !== undefined) continue
    q = q.join(leg.field, { as: leg.as, maxRows: leg.maxRows, strategy: leg.strategy })
  }
  let rows = q.toArray() as Array<Record<string, unknown>>
  // Remaining legs in DECLARATION order — which is what makes `from` work: a leg
  // may only name an alias declared earlier, so by the time it runs, the rows it
  // attaches to are already on the row. Root collect legs are in this loop too;
  // they were never part of the query chain.
  for (const leg of projection.joins) {
    if (isCollectLeg(leg)) {
      rows = applyCollectLeg(rows, leg, spec.name, projection.source, projection.joins, db)
    } else if (leg.from !== undefined) {
      rows = applyLegRelativeForwardLeg(rows, leg, spec.name, projection.source, projection.joins, db)
    }
  }
  const mapped: TRow[] = []
  for (const r of rows) {
    const m = projection.map(r)
    // null / undefined means "omit this primary row" — same contract
    // as the UNION arm `map`.
    if (m == null) continue
    mapped.push(m)
  }
  return finalizeMappedRows(spec, mapped)
}

/**
 * A `RefLookup` backed by the live join contexts — the executor's answer to the
 * same question the registry answers from the ref registry. Reads through, so a
 * ref declared after `openVault()` (the only place refs CAN be declared) is
 * visible here.
 *
 * @internal
 */
function legOwnerLookup(db: MVQueryContext): RefLookup {
  return (collection, field) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = db.collection<Record<string, unknown>>(collection).query() as any
    return (q._joinContext?.()?.resolveRef(field) as { target: string } | null | undefined) ?? null
  }
}

/**
 * Attach one FORWARD leg that hangs off another leg's alias (#1140).
 *
 * Root forward legs ride `Query.join()` and are resolved before this runs; a
 * leg-relative one cannot, because the FK it follows lives on an already-attached
 * record rather than on a column of the primary query. It is therefore resolved
 * the same way a collect leg is — one snapshot of the target collection, indexed
 * by id — which keeps it O(N+M) rather than one `get()` per row.
 *
 * Attaches `null` when the `from` alias is null (a dangling ref upstream), when
 * the FK is nullish, or when the target row is missing. That is deliberately
 * outer-by-nature and matches the collect leg's empty array: a projection MV
 * must not drop a primary row because something two hops away is absent.
 *
 * @internal
 */
function applyLegRelativeForwardLeg(
  primaryRows: ReadonlyArray<Record<string, unknown>>,
  leg: Extract<ProjectionJoinLeg, { field: string }>,
  mvName: string,
  source: string,
  joins: ReadonlyArray<ProjectionJoinLeg>,
  db: MVQueryContext,
): Array<Record<string, unknown>> {
  const lookup = legOwnerLookup(db)
  const owner = resolveLegOwner(leg, joins, source, lookup)
  const refDesc = owner === null ? null : lookup(owner, leg.field)
  if (owner === null || refDesc === null) {
    throw new MaterializedViewConfigError(
      `"${mvName}": projection leg "${leg.as}" requires a ref() on field "${leg.field}" of `
      + `collection "${owner ?? `(behind from: "${leg.from}")`}" — declare it on that collection, `
      + `then retry`,
    )
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const targetQ = db.collection<Record<string, unknown>>(refDesc.target).query() as any
  const byId = new Map<string, Record<string, unknown>>()
  for (const row of targetQ.toArray() as Array<Record<string, unknown>>) {
    const id = coerceCollectKey(row.id)
    if (id !== null) byId.set(id, row)
  }
  return primaryRows.map((row) => {
    const anchor = leg.from === undefined
      ? row
      : (row[leg.from] as Record<string, unknown> | null | undefined)
    const key = anchor == null ? null : coerceCollectKey(anchor[leg.field])
    return { ...row, [leg.as]: key === null ? null : byId.get(key) ?? null }
  })
}

/**
 * Attach one reverse "collect" leg (#810): every row of `leg.collect`
 * whose `leg.on` field references the ATTACH POINT's id lands in a
 * possibly-empty ARRAY under `leg.as` on that primary row. One
 * snapshot pass over the collect collection, hash-grouped by the `on`
 * FK — O(N+M), mirroring the forward hash-join fallback.
 *
 * The attach point is the primary record, or — with `from` (#1140) — the record
 * already attached under that alias. Matching then keys off `row[from].id`
 * instead of `row.id`, and `leg.on` must ref THAT leg's collection. A row whose
 * `from` alias is null (a dangling forward ref) gets `[]`, which is the same
 * outer-by-nature semantics a root collect leg already has for a primary record
 * with no children.
 *
 * Semantic check (first materialization, not factory time — parity
 * with join-time ref errors): `leg.on` must carry a `ref()` declared
 * on the collect collection targeting the attach point's collection.
 *
 * @internal
 */
function applyCollectLeg(
  primaryRows: ReadonlyArray<Record<string, unknown>>,
  leg: { readonly collect: string; readonly on: string; readonly as: string; readonly from?: string; readonly maxRows?: number },
  mvName: string,
  source: string,
  joins: ReadonlyArray<ProjectionJoinLeg>,
  db: MVQueryContext,
): Array<Record<string, unknown>> {
  const childColl = db.collection<Record<string, unknown>>(leg.collect)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const childQ = childColl.query() as any
  const refDesc = childQ._joinContext?.()?.resolveRef(leg.on) as { target: string } | null | undefined
  // The collection this leg matches AGAINST: the projection source for a root
  // leg, the `from` leg's own target otherwise (#1140).
  const expected = resolveLegOwner(leg, joins, source, legOwnerLookup(db))
  const expectedName = expected ?? source
  if (refDesc == null) {
    throw new MaterializedViewConfigError(
      `"${mvName}": projection collect leg "${leg.as}" requires a ref() on field "${leg.on}" of `
      + `collection "${leg.collect}" targeting "${expectedName}" — declare `
      + `refs: { ${leg.on}: ref('${expectedName}') } on collection "${leg.collect}", then retry`,
    )
  }
  if (refDesc.target !== expectedName) {
    throw new MaterializedViewConfigError(
      `"${mvName}": projection collect leg "${leg.as}" expects field "${leg.on}" of collection `
      + `"${leg.collect}" to reference ${leg.from === undefined
        ? `the projection source "${expectedName}"`
        : `"${expectedName}" (the collection behind from: "${leg.from}")`}`
      + `, but its ref() targets "${refDesc.target}"`,
    )
  }
  const maxRows = leg.maxRows ?? DEFAULT_JOIN_MAX_ROWS
  const groups = new Map<string, Array<Record<string, unknown>>>()
  for (const child of childQ.toArray() as Array<Record<string, unknown>>) {
    const key = coerceCollectKey(child[leg.on])
    // Nullish / non-scalar FK values mean "no reference" — same
    // narrowing as the forward join path's key coercion.
    if (key === null) continue
    const bucket = groups.get(key)
    if (bucket) bucket.push(child)
    else groups.set(key, [child])
  }
  const out: Array<Record<string, unknown>> = []
  for (const row of primaryRows) {
    // `from` matches against the attached record's id, not the primary row's.
    const anchor = leg.from === undefined
      ? row
      : (row[leg.from] as Record<string, unknown> | null | undefined)
    const key = anchor == null ? null : coerceCollectKey(anchor.id)
    const children = key === null ? [] : groups.get(key) ?? []
    if (children.length > maxRows) {
      throw new JoinTooLargeError({
        leftRows: primaryRows.length,
        rightRows: children.length,
        maxRows,
        side: 'right',
        message:
          `projection MV "${mvName}": collect leg "${leg.as}" gathered ${children.length} ` +
          `"${leg.collect}" rows for one "${source}" record, exceeding the ${maxRows}-row ` +
          `per-primary-row ceiling. Raise the ceiling via { maxRows } on the leg if the ` +
          `fan-out genuinely fits in memory, or restructure the child collection.`,
      })
    }
    out.push({ ...row, [leg.as]: children })
  }
  return out
}

/**
 * Coerce an unknown FK value into a collect-grouping key. Same
 * narrowing as the join path's `coerceRefKey` (not exported from
 * there): strings and numbers are legitimate ref values; anything
 * else is "no reference" and returns `null`.
 *
 * @internal
 */
function coerceCollectKey(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

/**
 * Run an MV's `query()` and write the result rows to the output
 * collection. Same-DEK encryption: routes through the standard
 * `Collection.put` pipeline, so the output collection's DEK is what
 * gets used (matches the v2 spec's "same DEK as the left-most source"
 * invariant — `Collection.put` looks up the DEK by collection name,
 * and the output collection IS the MV's owned collection).
 *
 * Stamps `_materializedFrom` onto every emitted row.
 *
 * **Tombstoning:** when `spec.onEmpty: 'delete'` (default), rows
 * that existed in a prior refresh but no longer appear in the new
 * materialized result are deleted via `Collection._internalDelete` —
 * the housekeeping bypass primitive prevents user
 * `onDelete` guards on the output collection from firing on these
 * system-internal deletes. `onEmpty: 'keep'` opts out (rows from
 * prior refreshes linger even when the new result lacks them).
 *
 * **Cost ceiling:** if the materialized row count exceeds
 * `spec.maxRows` (default 100k), throws `MaterializedViewTooLargeError`
 * before any writes hit the store — so strict-mode rollback is
 * clean.
 *
 * **Strict mode:** `spec.strict === true` re-throws on any
 * row-write failure; the active TxContext registration means the
 * source-write rolls back atomically via `revertExecuted`.
 *
 * @internal
 */
export const MaterializedViewExecutor = {
  async refresh(
    reg: RegisteredMV,
    accessor: MVExecutorAccessor,
  ): Promise<RefreshResult> {
    const spec = reg.spec
    const outputColl = accessor.getCollection(reg.outputCollection)
    const maxRows = spec.maxRows ?? DEFAULT_MAX_ROWS
    const onEmpty = spec.onEmpty ?? 'delete'
    const strict = spec.strict ?? false

    // 1. Materialize the query (branches on terminal shape). If the
    //    MV declared predicates, wrap the query context the same way
    //    the registry did at registration time so `.wherePredicate()`
    //    calls resolve to the registered functions.
    // #1414 — `ungatedMvContext` keeps the engine's synchronous source reads
    // exactly as they were before the cold-collection gate existed.
    const baseCtx = ungatedMvContext(accessor.getQueryContext())
    const ctxForQuery: MVQueryContext = spec.predicates
      ? wrapDbWithPredicates(baseCtx, spec.predicates)
      : baseCtx
    // UNION-form strategies: read every arm, map to the unified
    // row shape, concatenate, then optionally groupBy + aggregate.
    // Projection-form strategies (#810): hydrate the primary source,
    // attach forward + collect legs, map, then the same optional
    // grouping tail. The single-source `query()` path is untouched.
    let rows: ReadonlyArray<Record<string, unknown>>
    if (spec.unionSources) {
      rows = await materializeUnionResult(spec, ctxForQuery)
    } else if (spec.projection) {
      rows = await materializeProjectionResult(spec, ctxForQuery)
    } else {
      const q = spec.query!(ctxForQuery)
      rows = await materializeQueryResult(q, spec.name, spec.i18nLocale, spec.i18nFields)
    }

    // #1007 — the post-aggregate projection. Applied here, after every form has
    // produced its finished rows, so union / projection / query all get the
    // same single definition of "last step before materialisation".
    if (spec.derive) rows = applyDerive(spec, rows)

    // #777 — exclude this MV's OWN previously-stamped output rows from the
    // input scan. A same-collection Query-form MV copies the whole source row
    // verbatim into its output, so a stale output row can itself satisfy the
    // MV's own input filter (when the filter is on a field disjoint from the
    // partition field) and get re-selected as if it were live source — the
    // row self-perpetuates after its true source is gone. Prior output is
    // never this MV's own source.
    rows = rows.filter((row) => {
      const stamp = row._materializedFrom as { mvName?: string } | undefined
      return stamp?.mvName !== spec.name
    })

    // 2. Cost ceiling check BEFORE any writes — keeps the rollback
    //    clean if the source-write is wrapped in a transaction.
    if (rows.length > maxRows) {
      throw new MaterializedViewTooLargeError(spec.name, rows.length, maxRows)
    }

    const txCtx = accessor.getActiveTxContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (outputColl as any).adapter as {
      get(v: string, c: string, i: string): Promise<EncryptedEnvelope | null>
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultName = (outputColl as any).vault as string

    // 3. Compute the post-refresh id set so we can diff against the
    //    prior-emitted id set for tombstoning (when onEmpty === 'delete').
    const newIds = new Set<string>()
    const enrichedRows: Array<{ id: string; record: Record<string, unknown> }> = []
    for (const row of rows) {
      const id = spec.rowKey(row)
      newIds.add(id)
      const meta: MaterializedFromMeta = {
        mvName: spec.name,
        queryHash: reg.queryHash,
        sourceVersions: {},
        materializedAt: new Date().toISOString(),
      }
      enrichedRows.push({ id, record: { ...row, _materializedFrom: meta } })
    }

    // 4. Write the new rows — skipping any whose content is unchanged (#1418).
    //
    // ⛔ THE OUTPUT ROW COUNT, NOT THE SOURCE SCAN, IS WHAT MADE THIS EXPENSIVE.
    // This loop used to encrypt-and-store EVERY row of the view on EVERY source
    // write, so per-write cost tracked the size of the view: measured 23 ms at
    // 250 output rows and 41.6 ms at 450, for source writes the MV's own `map`
    // dropped entirely. Comparing against what this MV last wrote turns "one
    // source write rewrites the whole view" into "one source write rewrites the
    // groups that moved". See `emit-memo.ts` for why this, and not a
    // predict-whether-the-refresh-is-needed short circuit.
    const memoKey = emitMemoKey(vaultName, spec.name, reg.outputCollection)
    // Read the stamp BEFORE writing: it has to describe the collection as this
    // refresh found it, so a write by anyone else since last time invalidates.
    const priorEmitted = readEmitMemo(memoKey, outputColl._cacheStamp)
    const emitted = new Map<string, string>()

    let written = 0
    let skipped = 0
    let failed = 0
    for (const { id, record } of enrichedRows) {
      const contentKey = rowContentKey(record, reg.queryHash)
      // ⚠️ A txCtx changes what a "skip" means: the rollback journal below
      // needs an entry for every row the transaction could revert, and a row we
      // never wrote has nothing to revert TO. Rather than reason about partial
      // journals, the memo stands down inside a transaction entirely.
      // #1439 — and only when no `beforePut` gate can fire FOR THIS ROW. Asking
      // the bus "is anything registered" instead disabled the skip for every
      // collection in any vault carrying a guard or a periods strategy —
      // measured by the reporter at 54 redundant writes per source write with
      // guards alone, which is close to every real consumer.
      if (
        contentKey !== null && txCtx === null
        && !outputColl._derivedWriteGated(record)
        && priorEmitted?.get(id) === contentKey
      ) {
        skipped++
        emitted.set(id, contentKey)
        continue
      }
      try {
        if (txCtx !== null) {
          const prior = await adapter.get(vaultName, reg.outputCollection, id)
          txCtx._executed.push({
            op: { type: 'put', vaultName, collectionName: reg.outputCollection, id },
            priorEnvelope: prior,
          })
        }
        let landed = false
        if (accessor.dispatchCtx) {
          if (await putDerivedOutput(outputColl, id, record, accessor.dispatchCtx) === 'written') {
            written++
            landed = true
          }
        } else {
          await outputColl.put(id, record)
          written++
          landed = true
        }
        // ⛔ ONLY a write that actually landed is remembered. `putDerivedOutput`
        // declines inside a frozen period, and recording that row would make
        // every later refresh skip a row that is not there.
        if (landed && contentKey !== null) emitted.set(id, contentKey)
      } catch (err) {
        failed++
        if (strict) throw err
         
        console.warn(`[mv] "${spec.name}" row write failed:`, err)
      }
    }

    // 5. Tombstone rows that existed before but don't appear now.
    //    `onEmpty: 'keep'` skips this pass entirely. Uses
    //    `_internalDelete` so a user-registered `onDelete` on the
    //    output collection does NOT fire on housekeeping (composition fix).
    let deleted = 0
    const residueUndecodable: string[] = []
    const residueDeclined: string[] = []
    if (onEmpty === 'delete') {
      const priorIds = await listOutputIds(outputColl)
      for (const priorId of priorIds) {
        if (newIds.has(priorId)) continue
        // #762 — a same-collection partition MV (`output: { collection: <source>, partition }`,
        // the DERIV-PP30-001 shape) writes INTO its own source collection, so `listOutputIds`
        // also returns untouched USER source rows here. Decode each candidate and only
        // tombstone rows THIS MV stamped via `_materializedFrom.mvName` — the exact discipline
        // `invalidateMVAtRest` uses (stale.ts:151-162). An unstamped row, or one stamped by a
        // different MV, is never this MV's to delete.
        const priorEnvelope = await adapter.get(vaultName, reg.outputCollection, priorId)
        if (priorEnvelope === null) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const priorDecoded = await (outputColl as any)._decodeEnvelope(priorEnvelope, priorId)
        if (priorDecoded === null) {
          // #782 part a — ownership unknown (undecodable, e.g. elevated above tier 0 on a
          // tiered output collection): can't rule out this being THIS MV's own stamped row.
          // Surface it rather than silently skip (mirrors invalidateMVAtRest's #776 posture —
          // previously this leg had NO residue channel at all).
          residueUndecodable.push(`${reg.outputCollection}:${priorId}`)
          continue
        }
        const priorStampedBy =
          typeof priorDecoded === 'object'
            ? (priorDecoded as Record<string, unknown>)._materializedFrom as { mvName?: string } | undefined
            : undefined
        if (priorStampedBy?.mvName !== spec.name) continue
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const outAny = outputColl as any
          if (typeof outAny._internalDelete === 'function') {
            // #776 part b — gate on the boolean, matching invalidateMVAtRest's discipline
            // (stale.ts): `_internalDelete` returns `false` for a #718 elevated-skip (no
            // erasure happened), and that must not inflate the tombstone count.
            if (await outAny._internalDelete(priorId, txCtx)) {
              deleted++
            } else {
              // #782 part b — decoded AND stamp-owned, but erasure was declined (#718
              // tier-elevation gate). Ownership IS confirmed here — a real silent survival,
              // not a legit stamp-mismatch skip. Surface it too.
              residueDeclined.push(`${reg.outputCollection}:${priorId}`)
            }
          } else {
            // Defensive fallback — should never hit in real flow since
            // every Collection has `_internalDelete`.
            await outputColl.delete(priorId)
            deleted++
          }
        } catch (err) {
          failed++
          if (strict) throw err

          console.warn(`[mv] "${spec.name}" tombstone failed for id="${priorId}":`, err)
        }
      }
    }

    // Record the stamp AFTER every write and tombstone, so the next refresh's
    // check means "nothing has happened to this collection since I finished".
    // A row that failed, was declined, or was tombstoned is simply absent from
    // `emitted` and will be written again.
    writeEmitMemo(memoKey, outputColl._cacheStamp, emitted)

    return { written, skipped, deleted, failed, residueUndecodable, residueDeclined }
  },
}

/**
 * List ids currently present in the MV's output collection via the
 * adapter directly (avoids triggering the lazy resolve-on-read path
 * we're INSIDE). Returns an empty array if the collection doesn't
 * exist or the adapter doesn't surface a list method.
 *
 * @internal
 */
async function listOutputIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outputColl: Collection<any>,
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cAny = outputColl as any
  const adapter = cAny.adapter as { list?: (v: string, c: string) => Promise<readonly string[]> }
  const vault = cAny.vault as string
  const name = cAny.name as string
  if (typeof adapter?.list !== 'function') return []
  try {
    const ids = await adapter.list(vault, name)
    return [...ids]
  } catch {
    return []
  }
}
