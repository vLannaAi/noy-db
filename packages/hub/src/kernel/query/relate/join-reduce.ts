/**
 * Reducing over a JOIN ALIAS (#1338).
 *
 * `aggregate()` and `groupBy()` used to refuse any field rooted at a join
 * alias. The refusal's own doc named the real blocker, and it was never "the
 * legs do not run" — running them is the easy half. It was that the Via
 * pipeline is LEFT-SCOPED: `Query.aggregate()` calls
 * `this.source.via.wrapReducers(spec)`, which resolves every reducer's field
 * against the LEFT collection's map. For `sum('client.balance')` that map has
 * no entry, so two things silently did not happen — money's exact-BigInt
 * rewrite was skipped (a generic sum over stored scaled-integer strings, which
 * `readNumber` coerces to 0), and `refuseUnqueryableReducers` never fired, so
 * the `queryable: 'none'` gate that would refuse a blob field never applied.
 *
 * This module supplies the missing half as a Via BINDING rather than as a
 * special case threaded through the reduce strategy. A binding composes: the
 * pipeline handed to `GroupedQuery`/`aggregate()` is the left one plus this,
 * so every existing call site keeps its exact behaviour and the alias case
 * arrives through the same `wrapReducers` door as everything else.
 *
 * Two properties make that safe:
 *
 *  - **It delegates, it does not reimplement.** An aliased reducer is handed
 *    to the RIGHT collection's OWN pipeline under its BARE field name — which
 *    is how a pipeline is keyed (that is the whole shape of #1335) — so the
 *    right side's rewrite AND its posture gate apply together, from one call.
 *  - **`covers()` returns false**, so the binding is inert for `postureFor`,
 *    `present`, `decodeResults` and every other phase. It exists for exactly
 *    one hook.
 */
import type { NoydbVia } from '../../via/index.js'
import { ViaPipeline } from '../../via/pipeline.js'

/**
 * The reducer shape this file needs, declared STRUCTURALLY rather than
 * imported from `with-lookup/reduce/`.
 *
 * Not a style choice: `check-architecture.mjs`'s port-layering guard refuses a
 * NEW static kernel→`with-*` import (its allowlist is a frozen per-file, per-
 * specifier baseline, and adding a row would be the thing the freeze exists to
 * stop). `NoydbVia.wrapReducers` is declared `(spec: unknown) => unknown`
 * precisely so a binding never has to name the service's types, and these
 * three members are all this file touches — every reducer that reaches it was
 * built by the reduce service and keeps every other member intact through the
 * spread below.
 */
interface AliasReducer {
  readonly field?: string
  init(): unknown
  step(state: unknown, record: unknown): unknown
  remove?(state: unknown, record: unknown): unknown
  finalize(state: unknown): unknown
}
type AliasSpec = Readonly<Record<string, AliasReducer>>

/**
 * Re-aim a reducer at the sub-record under `alias`.
 *
 * The right side's pipeline rewrote the reducer for the BARE field name, so
 * its `step`/`remove` read `credit` off whatever record they are handed. On a
 * joined row that value lives at `row.client.credit`, so the row is unwrapped
 * one level on the way in rather than the field path being rewritten — the
 * rewritten reducer closes over its field name internally, so re-pointing the
 * `.field` property afterwards would change the label and not the read.
 *
 * An unmatched left row carries `null` under the alias; every reducer's read
 * already treats a nullish record as "no value here", so it contributes
 * nothing — the same thing a missing left-side field does.
 */
function liftToAlias(alias: string, path: string, inner: AliasReducer): AliasReducer {
  const under = (record: unknown): unknown =>
    record === null || typeof record !== 'object' ? undefined : (record as Record<string, unknown>)[alias]
  return {
    ...inner,
    // The dotted path, so anything reading `.field` for a label or a
    // dependency still sees the field the CALLER named.
    field: path,
    init: () => inner.init(),
    step: (state, record) => inner.step(state, under(record)),
    ...(inner.remove ? { remove: (state: unknown, record: unknown) => inner.remove!(state, under(record)) } : {}),
    finalize: (state) => inner.finalize(state),
  }
}

/**
 * The binding: rewrite every reducer whose field is rooted at a join alias
 * through that alias's own collection pipeline, and leave everything else
 * exactly as it arrived.
 *
 * A reducer the right side does NOT rewrite (a plain `avg('client.score')`)
 * is returned untouched and keeps reading the dotted path off the joined row,
 * which is already correct — only a REWRITTEN reducer needs lifting, because
 * only a rewritten one has swapped to the bare name.
 */
function joinAliasBinding(aliasVia: ReadonlyMap<string, ViaPipeline>): NoydbVia {
  return {
    brand: 'join-alias',
    posture: { encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: true },
    // Claims no field: this binding must never shadow a left-side posture.
    covers: () => false,
    wrapReducers: (spec) => {
      let changed = false
      const out: Record<string, AliasReducer> = {}
      for (const [key, reducer] of Object.entries(spec as AliasSpec)) {
        const field = reducer.field
        const dot = field === undefined ? -1 : field.indexOf('.')
        const via = dot > 0 ? aliasVia.get(field!.slice(0, dot)) : undefined
        if (!via) { out[key] = reducer; continue }
        const bare = field!.slice(dot + 1)
        // One call: the right side's rewrite and its `queryable: 'none'`
        // refusal, both keyed by the bare name it actually declares.
        const wrapped = via.wrapReducers({ [key]: { ...reducer, field: bare } } as AliasSpec)[key]!
        if (wrapped === reducer || wrapped.field !== bare) { out[key] = reducer; continue }
        changed = true
        out[key] = liftToAlias(field!.slice(0, dot), field!, wrapped)
      }
      return changed ? out : spec
    },
  }
}

/**
 * The pipeline `aggregate()` / `groupBy()` should reduce THIS plan with: the
 * source's own, plus the alias binding when the plan can produce an alias.
 *
 * Returns the left pipeline unchanged when there is no alias to serve, so a
 * query with no joins — every query written before #1338 — is handed exactly
 * the object it was handed before.
 */
export function reduceViaFor(
  leftVia: ViaPipeline | undefined,
  aliasVia: ReadonlyMap<string, ViaPipeline> | undefined,
): ViaPipeline | undefined {
  if (aliasVia === undefined || aliasVia.size === 0) return leftVia
  return ViaPipeline.build([...(leftVia?.bindings ?? []), joinAliasBinding(aliasVia)], leftVia?.taint)
}

/**
 * The other half, and the reason this one is not merely a missing feature:
 * a binding that REFUSES an aliased reducer instead of rewriting it.
 *
 * It is installed on the path where the legs do NOT run —
 * `groupBy('status').aggregate({ x: sum('client.credit') })`, a group key over
 * a left field with a reducer over an alias. `Query.aggregate()`'s guard never
 * saw that spec (the grouped terminal is `GroupedQuery.aggregate`, one object
 * along the chain), so it reduced `undefined` for every row and returned a
 * confident `0`. Group by the alias — then the legs run and the reducer is
 * rewritten by the branch above — or drop the grouping.
 */
function refuseAliasBinding(aliases: ReadonlySet<string>): NoydbVia {
  return {
    brand: 'join-alias-refuse',
    posture: { encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: true },
    covers: () => false,
    wrapReducers: (spec) => {
      for (const reducer of Object.values(spec as AliasSpec)) {
        const field = reducer.field
        if (field === undefined) continue
        const head = field.split('.')[0]!
        if (!aliases.has(head)) continue
        throw new Error(
          `Query.groupBy().aggregate(): reducer field "${field}" addresses the join alias ` +
            `"${head}", but the GROUP KEY does not — so the join legs are not applied for ` +
            `this grouping and the reducer would fold undefined into every bucket. ` +
            `Group by a field on "${head}" (then the legs run), or aggregate without ` +
            `grouping, where an aliased reducer is applied directly.`,
        )
      }
      return spec
    },
  }
}

/**
 * The pipeline for a grouped plan whose GROUP KEY stays on the left: the
 * source's own, plus the refusal above so an aliased reducer is a loud error
 * rather than a confident zero. No aliases in the plan → unchanged.
 */
export function refuseAliasReduceVia(
  leftVia: ViaPipeline | undefined,
  aliases: ReadonlySet<string>,
): ViaPipeline | undefined {
  if (aliases.size === 0) return leftVia
  return ViaPipeline.build([...(leftVia?.bindings ?? []), refuseAliasBinding(aliases)], leftVia?.taint)
}
