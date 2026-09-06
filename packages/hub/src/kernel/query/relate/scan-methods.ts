/**
 * #1458 — the **Relate** half of `ScanBuilder`.
 *
 * `join` · plus the two streaming-join privates the iterator calls.
 *
 * ⭐ **`ScanBuilder` gets the same treatment as `Query` because it has the same
 * problem** (ruled 2026-09-06): it is one class carrying Find (`where`,
 * `filter`, the async iterator), Reduce (`aggregate`, `groupBy`) and Relate
 * (`join`) methods, and `sideEffects: false` cannot drop a method. Left
 * unsplit it would have kept `relate/join.ts` and the whole reducer engine in
 * every `/query` bundle no matter what `Query` did — the architecture rule
 * would have been true of `builder.ts` and false of the package.
 *
 * ⚠️ `buildJoinResolvers` and `applyOneJoinStreaming` are called from the
 * ITERATOR, which stays in Find. Both calls sit behind `joins.length === 0`,
 * so a Find-only scan never reaches them — the same guarantee, and the same
 * shape of guarantee, as `internal/hooks.ts` gives the eager executor.
 */
import { ScanBuilder } from '../scan-builder.js'
import type { ScanPageProvider } from '../scan-builder.js'
import type { QueryField } from '../../types.js'
import type { Clause } from '../predicate.js'
import type { ViaPipeline } from '../../via/pipeline.js'
import type { JoinContext, JoinLeg, JoinableSource } from './join.js'
import { DanglingReferenceError, RefNotDeclaredError } from '../../errors.js'
import { readPath } from '../predicate.js'
// ⭐ `scan-builder.ts` carried a byte-identical private copy of this. The two
// were always the same policy — "a nullish FK is not dangling, in either
// builder" — so the split folded the duplicate into the one `join.ts` already
// published rather than moving a second definition into this file.
import { coerceRefKey } from './join.js'

/** One resolved leg, prepared once per iteration. @internal */
export interface ScanJoinResolver {
  leg: JoinLeg
  source: JoinableSource
  lookupById: ((id: string) => unknown) | null
  hashByPrimaryKey: ReadonlyMap<string, unknown> | null
  warnedKeys: Set<string>
}

/** @internal — the mixin whose prototype `./index.ts` copies onto `ScanBuilder`. */
export class ScanRelateMethods<T, S extends keyof T = never, M extends keyof T & string = never> {
  declare protected readonly pageProvider: ScanPageProvider<T>
  declare protected readonly pageSize: number
  declare protected readonly clauses: readonly Clause[]
  declare protected readonly joins: readonly JoinLeg[]
  declare protected readonly joinContext: JoinContext | undefined
  declare protected readonly via: ViaPipeline | undefined

  /**
   * Resolve a `ref()`-declared foreign key per record as the scan
   * stream flows, attaching the right-side record (or null) under
   * `opts.as`. — streaming joins over `scan()`.
   *
   * ```ts
   * for await (const inv of invoices.scan().join('clientId', { as: 'client' })) {
   *   await processInvoice(inv) // inv.client is attached
   * }
   *
   * // Or terminate with .aggregate() for streaming joined aggregation
   * const { total } = await invoices.scan()
   *   .where('status', '==', 'open')
   *   .join('clientId', { as: 'client' })
   *   .aggregate({ total: sum('amount') })
   * ```
   *
   * **The key difference from eager `.join()`:** the LEFT
   * side streams page-by-page from the adapter and is never
   * materialized. Memory ceiling on the left is O(pageSize), not
   * O(rowCount). This is what makes streaming joins suitable for
   * collections that exceed the eager join's 50_000-row ceiling.
   *
   * **Right-side strategy** is auto-selected per leg:
   *   - **Indexed** — right source exposes `lookupById`, so each
   *     left row costs O(1). This is the common path for
   *     Collection right sides, which back `lookupById` with a Map
   *     lookup over the in-memory cache. The right collection must
   *     be in eager mode (the same constraint as eager join's
   *     `querySourceForJoin` from ).
   *   - **Hash** — right source has only `snapshot()`. Build a
   *     `Map<id, record>` once at iteration start, probe per left
   *     row. Same correctness, same per-row cost as the indexed
   *     path; the difference is the upfront cost of materializing
   *     the right side once.
   *
   * Both strategies hold the right side in memory for the duration
   * of the iteration. The "streaming" property applies to the LEFT
   * side only — true left-and-right streaming joins (where neither
   * side fits in memory) require a sort-merge join planner that's
   * out of scope for.
   *
   * **Ref-mode semantics** match eager `.join()` exactly:
   *   - `strict`  → throws `DanglingReferenceError` mid-stream
   *     when a left record points at a non-existent right id.
   *     The throw aborts the async iterator — consumers should
   *     wrap the `for await` in try/catch if they want to recover.
   *   - `warn`    → attaches `null` and emits a one-shot warning
   *     per unique dangling pair (deduped via the same warn
   *     channel as eager join).
   *   - `cascade` → attaches `null` silently. A delete-time mode;
   *     dangling refs at read time are mid-flight or pre-existing
   *     orphans, not a DSL error.
   *
   * Left records with null/undefined FK values attach `null`
   * regardless of mode — same "no reference at all" policy as
   * eager join and write-time `enforceRefsOnPut`.
   *
   * **Multi-FK chaining** is supported via repeated `.join()`
   * calls: each leg resolves an independent ref. Each leg
   * independently picks its right-side strategy and applies its
   * own ref mode.
   *
   * **Joins are NOT applied** to a `.aggregate()` terminal that
   * doesn't reference joined fields — wait, that's not quite
   * right. The streaming path actually DOES apply joins before
   * `.aggregate()` because the join attaches a field that the
   * spec might reference. Unlike `Query.aggregate()` (which skips
   * joins entirely as a projection-only short-circuit), the
   * streaming aggregation can't know whether the spec touches a
   * joined field, so it always applies joins. Consumers who want
   * unjoined streaming aggregation should leave `.join()` off the
   * chain — the chain is composable for a reason.
   *
   * Every JoinLeg carries `partitionScope: 'all'`, plumbed through but never
   * read. Same seam as the eager join — see {@link JoinLeg.partitionScope}.
   */
  join<As extends string, R = unknown>(
    field: QueryField<T, S>,
    opts: { as: As },
  ): ScanBuilder<T & Record<As, R | null>, S, M> {
    if (!this.joinContext) {
      throw new Error(
        `ScanBuilder.join() requires a join context. Use ` +
          `collection.scan() to construct a join-capable scan instead ` +
          `of the ScanBuilder constructor directly (the direct ` +
          `constructor is only used for tests with synthetic page ` +
          `providers).`,
      )
    }
    const descriptor = this.joinContext.resolveRef(field)
    if (!descriptor) {
      // Typed for the same reason `Query.join()` is (#1139) — see RefNotDeclaredError.
      throw new RefNotDeclaredError({
        collection: this.joinContext.leftCollection,
        field,
        message:
          `ScanBuilder.join(): no ref() declared for field "${field}" on ` +
          `collection "${this.joinContext.leftCollection}". Add ` +
          `refs: { ${field}: ref('<target-collection>') } to the ` +
          `collection options, then retry.`,
      })
    }
    const leg: JoinLeg = {
      field,
      as: opts.as,
      target: descriptor.target,
      mode: descriptor.mode,
      strategy: undefined,
      maxRows: undefined,
      // Always 'all', never read by the streaming executor. This is the
      // path where partition pruning would actually pay (every listPage()
      // page is decrypted) — and the path blocked on a store-contract
      // change. See JoinLeg.partitionScope constraint 2 (#1342).
      partitionScope: 'all',
    }
    return new ScanBuilder<T & Record<As, R | null>, S, M>(
      this.pageProvider as unknown as ScanPageProvider<T & Record<As, R | null>>,
      this.pageSize,
      this.clauses,
      [...this.joins, leg],
      this.joinContext,
      this.via,
    )
  }

  /**
   * Iterate the scan as an async iterable. Walks the page
   * provider's cursors forward until exhaustion, applying every
   * clause per record — only matching records are yielded.
   *
   * Backward-compatible with the previous async-generator `scan()`
   * return type for `for await … of` consumers.
   */

  /**
   * Per-leg right-side resolution state. Built once at iteration
   * start and reused for every left record. Two strategies:
   *
   *   - `lookupById`: present when the right source exposes the
   *     hook directly (typical Collection right side). Per-row
   *     cost is O(1).
   *   - `hashByPrimaryKey`: built from `snapshot()` when no
   *     lookupById. Per-row cost is O(1) after the upfront O(N)
   *     materialization. Same as eager join's hash strategy.
   *
   * `warnedKeys` is the per-leg dedup set for ref-mode 'warn'. We
   * key on `field→target:refId` so the same dangling pair only
   * warns once per iteration. The dedup is per-iteration, not
   * per-process — a long-running scan that re-iterates would warn
   * again, which is the desired behavior (the data may have
   * changed between iterations).
   */
  private buildJoinResolvers(): Array<{
    leg: JoinLeg
    source: JoinableSource
    lookupById: ((id: string) => unknown) | null
    hashByPrimaryKey: ReadonlyMap<string, unknown> | null
    warnedKeys: Set<string>
  }> {
    if (!this.joinContext) {
      // Unreachable — .join() throws if joinContext is missing.
      // Belt-and-braces because the iterator is invoked via
      // Symbol.asyncIterator on a builder that may have been
      // constructed via the direct constructor with pre-populated
      // joins.
      throw new Error(
        `ScanBuilder iterator: ${this.joins.length} join leg(s) ` +
          `present but no JoinContext attached. Use collection.scan() ` +
          `to construct a join-capable scan.`,
      )
    }
    const resolvers: Array<{
      leg: JoinLeg
      source: JoinableSource
      lookupById: ((id: string) => unknown) | null
      hashByPrimaryKey: ReadonlyMap<string, unknown> | null
      warnedKeys: Set<string>
    }> = []
    for (const leg of this.joins) {
      // #1339 — unreachable today (`ScanBuilder` builds its own ref legs and
      // has no `.joinOn()`), and loud rather than silent if that ever
      // changes: a declared `on` is many-to-many, so it emits one row per
      // match, which the one-record-in/one-record-out streaming contract
      // below cannot express.
      if (leg.on !== undefined) {
        throw new Error(
          `ScanBuilder: the declared \`on\` join leg "${leg.as}" cannot stream — it emits one row ` +
            `per match, while scan() yields one row per stored record. Use collection.query().joinOn().`,
        )
      }
      const source = this.joinContext.resolveSource(leg.target)
      if (!source) {
        throw new Error(
          `ScanBuilder.join() cannot resolve target collection ` +
            `"${leg.target}" (referenced from field "${leg.field}" on ` +
            `"${this.joinContext.leftCollection}"). Make sure the target ` +
            `collection has been opened via vault.collection() ` +
            `at least once before iterating the scan.`,
        )
      }
      // Strategy selection: prefer lookupById when available
      // (O(1) per row, no upfront cost), fall back to hashing
      // snapshot() once otherwise.
      let lookupById: ((id: string) => unknown) | null = null
      let hashByPrimaryKey: ReadonlyMap<string, unknown> | null = null
      if (source.lookupById) {
        // Bind through an arrow so the lookupById's `this`
        // doesn't drift — same pattern as the eager join's
        // strategy resolver.
        const fn = source.lookupById.bind(source)
        lookupById = (id: string): unknown => fn(id)
      } else {
        const map = new Map<string, unknown>()
        for (const record of source.snapshot()) {
          const rawId = readPath(record, 'id')
          const key = coerceRefKey(rawId)
          if (key !== null) map.set(key, record)
        }
        hashByPrimaryKey = map
      }
      resolvers.push({
        leg,
        source,
        lookupById,
        hashByPrimaryKey,
        warnedKeys: new Set<string>(),
      })
    }
    return resolvers
  }

  /**
   * Resolve a single join leg for one left record and return the
   * left record with the joined field attached under
   * `leg.as`. Pure function over `(left, resolver)`; never
   * mutates the input.
   *
   * Ref-mode dispatch matches eager `applyJoins` from :
   *   - null/undefined FK → attach null silently (always allowed)
   *   - dangling FK + strict → throw `DanglingReferenceError`
   *   - dangling FK + warn → attach null, warn-once per pair
   *   - dangling FK + cascade → attach null silently
   */
  private applyOneJoinStreaming(
    left: unknown,
    resolver: {
      leg: JoinLeg
      source: JoinableSource
      lookupById: ((id: string) => unknown) | null
      hashByPrimaryKey: ReadonlyMap<string, unknown> | null
      warnedKeys: Set<string>
    },
  ): unknown {
    if (left === null || typeof left !== 'object') {
      // Pathological input; matches eager join's defensive return.
      return left
    }
    const { leg } = resolver
    const rawId = readPath(left, leg.field)
    const refKey = coerceRefKey(rawId)
    let right: unknown = undefined
    if (refKey !== null) {
      if (resolver.lookupById !== null) {
        right = resolver.lookupById(refKey)
      } else if (resolver.hashByPrimaryKey !== null) {
        right = resolver.hashByPrimaryKey.get(refKey)
      }
    }

    const merged: Record<string, unknown> = {
      ...(left as Record<string, unknown>),
    }
    if (right === undefined) {
      // No matching record. Distinguish "no ref at all" (null FK)
      // from "dangling ref" (FK pointed at nothing).
      if (refKey !== null && leg.mode === 'strict') {
        throw new DanglingReferenceError({
          field: leg.field,
          target: leg.target,
          refId: refKey,
          message:
            `ScanBuilder.join() strict dangling: record references ` +
            `"${leg.target}:${refKey}" via field "${leg.field}", but no ` +
            `such record exists. Use ref() mode 'warn' or 'cascade' if ` +
            `dangling refs are acceptable, or run ` +
            `vault.checkIntegrity() to find and fix the orphans.`,
        })
      }
      if (refKey !== null && leg.mode === 'warn') {
        const dedupKey = `${leg.field}→${leg.target}:${refKey}`
        if (!resolver.warnedKeys.has(dedupKey)) {
          resolver.warnedKeys.add(dedupKey)
          console.warn(
            `[noy-db] ScanBuilder.join() encountered dangling ref in ` +
              `'warn' mode: field "${leg.field}" → "${leg.target}:` +
              `${refKey}" not found. Attaching null.`,
          )
        }
      }
      // strict already threw above; warn falls through here; cascade
      // hits this path silently.
      merged[leg.as] = null
    } else {
      merged[leg.as] = right
    }
    return merged
  }

  /**
   * Reduce the scan stream through a named set of reducers and
   * return the final aggregated shape.
   *
   * Memory is O(reducers): one mutable state slot per spec key.
   * Records flow through the pipeline one at a time via
   * `for await` and are discarded after their `step()` is applied
   * — never collected into an array. This is the distinguishing
   * property from `Query.aggregate()`, which materializes the full
   * match set first.
   *
   * Reuses the same reducer protocol as `Query.aggregate()`,
   * so `count()`, `sum(field)`, `avg(field)`, `min(field)`,
   * `max(field)` all work unchanged. The `{ seed }` parameter
   * plumbing from  constraint #2 is honored transparently — the
   * factories ignore it in and the scan executor never
   * touches the per-reducer state construction.
   *
   * **Returns a Promise**, unlike `Query.aggregate().run()` which
   * is synchronous. The scan is inherently async because it walks
   * adapter pages, so the terminal has to be too. Consumers
   * destructure with await:
   *
   * ```ts
   * const { total, n } = await invoices.scan()
   *   .where('year', '==', 2025)
   *   .aggregate({ total: sum('amount'), n: count() })
   * ```
   *
   * **No `.live()` in.** `scan().aggregate().live()` would
   * require reconciling an unbounded streaming iteration with a
   * change-stream subscription — a design problem, not just a code
   * one. Consumers with huge collections and live needs should
   * narrow with `.where()` enough to fit in the 50k `query()`
   * limit and use `query().aggregate().live()` instead.
   *
   * Consults the Via pipeline's posture before reducing (#629 Task 8 review
   * fix wave 1): a reducer over a field whose posture is `queryable: 'none'`
   * throws `FieldNotQueryableError` here, metadata-only — via
   * `ViaPipeline.refuseUnqueryableReducers`, NOT the full `wrapReducers`
   * (which would also activate money's exact-reducer rewrite, a path this
   * method has never run and must not start running as a side effect of
   * this gate).
   */
  // `const` so an inline `[specA, specB]` infers as a TUPLE, not a `Spec[]` —
  // that is what makes `const [a, b] = await …` land on the right shapes.
}

/** The public Relate surface of `ScanBuilder` — merged by `./index.ts`. */
export type ScanRelateSurface<
  T,
  S extends keyof T = never,
  M extends keyof T & string = never,
> = Pick<ScanRelateMethods<T, S, M>, 'join'>
