// kernel/via-graph-wiring.ts — thin per-vault wiring that feeds `ViaGraph`
// from the collection-declare edge sources (via bindings' `deps`, `computed`)
// at collection-construction time (#638 Task 2). The with-formula (derivation/
// MV/overlay) edge sources are registered directly by `Vault._initDerivations`/
// `_initMaterializedViews`/`_initOverlayedViews` from their registries' own
// `edges()` accessors — this file only covers the per-collection sources,
// which fire on every `Vault.collection()` call, not just vaults that declare
// a derivation/MV/overlay strategy.
import type { ViaGraph } from './via-graph.js'
import type { ViaPosture } from './via.js'
import {
  resolveCollectionConfig, resolveComputedEdges, computedEntryParts, collectKnownFieldNames,
  type CollectionOpts, type GraphEdge,
} from './collection-config.js'
import { resolveClassifiedFields, type ClassifiedEntry } from '../port/with/classified-strategy.js'
import { ValidationError } from './errors.js'
import { ViaPipeline, type ViaTaintOverlay } from './via-pipeline.js'
import { buildTaintOverlay, taintBinding } from './via-taint-binding.js'

// `ComputedFields` is a with-formula/computed type; the kernel spine may not
// statically import a with-* service (S5 port-layering — see
// scripts/check-architecture.mjs's checkPortLayering). Derive the type from
// the already-permitted `resolveComputedEdges` signature (collection-config.ts
// is grandfathered for the real with-formula import) instead of importing it
// directly here.
type ComputedFieldsParam = NonNullable<Parameters<typeof resolveComputedEdges>[1]>

// The classified via-binding's fixed posture (`shape/via-classified/binding.ts`'s
// `classifiedBinding().posture` — byte-for-byte duplicate, uniform across every
// storage form, stable since #629 Task 5). Duplicated here rather than
// imported: the reconcile commit path (unlike fresh construction) has no
// compiled `ViaPipeline` to read `binding.posture` off of, and the kernel
// spine may not statically reach a with-*/shape service for it. Same
// documented-duplication-risk class as `WHOLE_RECORD`
// (`with-formula/materialized-views/registry.ts`) — keep in sync by hand.
const CLASSIFIED_POSTURE: ViaPosture = { encryptedAtRest: 'sealed', queryable: 'det-exact', exportable: false, forgettable: true }

/**
 * Register one collection's field postures (`binding.posture` + `covers()`)
 * and computed/via-binding-deps edges onto the vault's shared graph. Called
 * from `Vault.collection()`'s fresh-construction path, right after the real
 * `Collection` is built from the SAME `opts` — `resolveCollectionConfig` is a
 * pure function, so re-running it here (Collection's constructor already ran
 * it once internally) costs a one-time, side-effect-free recomputation at
 * collection-declare time, not a per-write cost.
 */
export function registerCollectionGraphSources<T>(graph: ViaGraph, name: string, opts: CollectionOpts<T>): void {
  const cfg = resolveCollectionConfig(opts)
  const bindings = cfg.via?.bindings ?? []
  const knownFields = new Set<string>([
    ...Object.keys(cfg.moneyFields ?? {}),
    ...Object.keys(cfg.i18nFields ?? {}),
    ...Object.keys(cfg.dictKeyFields ?? {}),
    // #650 Task 2 — native lookup()/enumOf()/dict() fields register their
    // posture (`lookupBinding().posture`) the same generic way every other
    // binding does; no `'ref'` EdgeKind / graph edge yet (Task 5).
    ...Object.keys(cfg.lookupFields ?? {}),
    ...(cfg.classified !== undefined ? Object.keys(cfg.classified.byField) : []),
  ])
  for (const field of knownFields) {
    for (const binding of bindings) {
      if (binding.covers?.(field)) {
        graph.registerField(name, field, binding.posture)
        break
      }
    }
  }
  // #638 Task 7 — `edge.grain` defaults to 'record' (with-formula edges and
  // materialized computed edges never set it); a virtual computed field's
  // edge carries `grain: 'virtual'` (`resolveComputedEdges`).
  for (const edge of cfg.computedEdges) graph.registerDerived(edge.target, edge.sources, 'computed', edge.grain ?? 'record')
  for (const edge of cfg.viaDepsEdges) graph.registerDerived(edge.target, edge.sources, 'computed', edge.grain ?? 'record')

  // #638 Task 2 fix wave 2 — record the combined-state leak-guard memory
  // (Finding I1) a LATER, separate reconcile call needs: which raw
  // user-declared computed fields have no declared `deps` (depless — legal
  // here since no classified field is present yet, so nothing to register
  // an edge against), and whether this collection has any classified field
  // at all. `cfg.computedFieldNames` (#638 Task 7) is EVERY declared
  // computed field name across both modes/surfaces — not just
  // `opts.computed`'s sugar keys — so a `via(computed(...))`-declared field
  // participates in this guard identically to a sugar-declared one.
  if (cfg.classified !== undefined) graph.markClassified(name)
  const depFields = new Set(cfg.computedEdges.map((edge) => edge.target.field))
  for (const field of cfg.computedFieldNames) {
    if (!depFields.has(field)) graph.markDepslessComputed(name, field)
  }
}

/** The slice of `Vault.collection()`'s reconcile-path options relevant to
 *  graph registration — money/computed/classifiedFields are the only
 *  options `Vault.collection()`'s reconcile branches actually attach
 *  (i18nFields/dictKeyFields are construction-only, never reconciled). */
export interface ReconcileGraphOptions {
  readonly moneyFields?: Record<string, unknown>
  readonly classifiedFields?: Record<string, ClassifiedEntry>
  readonly computed?: ComputedFieldsParam
}

/** Phase 1's output — what phase 2 (`commitReconcileGraphEdges`) applies once
 *  every `_apply*` mutation for this reconcile call has succeeded. */
export interface ReconcilePlan {
  readonly edges: readonly GraphEdge[]
  readonly depslessComputedFields: readonly string[]
  readonly classifiedFieldNames: readonly string[]
}

/**
 * Phase 1 (validate) of the reconcile-path's two-phase graph wiring (#638
 * Task 2 fix wave 2). Pure — throws `ValidationError`, never mutates `graph`.
 *
 * Evaluates the COMBINED existing+incoming computed/classified state, using
 * `graph` as the vault-side memory of what a PRIOR, separate
 * `vault.collection()` call already registered (review Finding I1): a
 * depsless computed field declared while no classified field existed yet
 * registers no edge (`registerCollectionGraphSources` marks it instead), so a
 * LATER call newly introducing a PERSISTABLE (`recoverable`/`digest-only`)
 * classified field must still see it and refuse, regardless of which call
 * declared which piece first. `storage: 'never'` fields are exempt from this
 * specific check: `enforceClassifiedWrite` rejects the whole write BEFORE
 * computed fields ever evaluate (`Collection._putInternal`'s pipeline order —
 * enforceWrite, then computed), so a `never`-stored value structurally cannot
 * reach a computed field's output. (`resolveComputedEdges` below, unchanged,
 * still blanket-refuses a depsless field THIS SAME call introduces alongside
 * ANY classified field regardless of storage — same as fresh construction.)
 * Given that, once a PERSISTABLE classified field is successfully committed
 * for a collection, no depsless computed field can survive uncaught (this
 * very check, or the identical fresh-construction one, would already have
 * refused it) — so this check only needs THIS call's own incoming
 * `classifiedFields`, never `graph`'s classified memory.
 *
 * Each `computed` entry's own `deps` (#638 Task 7 — the reconcile path only ever sees the
 * `computed:` sugar option, per `ReconcileGraphOptions`'s doc comment; `via(computed(...))`
 * is construction-only like i18nFields/dictKeyFields) are resolved via `resolveComputedEdges`
 * exactly like the fresh-construction path — Finding I2ii's original knownFields-sharing
 * concern is back in play for the Task 7 review's CRITICAL fix: on a collection that
 * declares classified fields, `resolveComputedEdges` now checks every `deps` entry against
 * a `knownFields` universe built via the SAME `collectKnownFieldNames` helper the fresh path
 * uses (never a hand-rolled second universe), scoped to THIS call's own
 * `moneyFields`/`classifiedFields`/`computed` options (see `resolveComputedEdges`'s own doc
 * comment for the full rationale and its documented residual limit). On a non-classified
 * collection a plain, non-via field is still a legal dep, unchanged from Task 7.
 *
 * Callers MUST call this BEFORE any `_apply*` mutation runs, and must only
 * call `commitReconcileGraphEdges` with the result AFTER every `_apply*` for
 * this call has succeeded (Finding M2 — no partial graph state may survive a
 * reconcile call whose config is ultimately rejected).
 */
export function validateReconcileGraphEdges(graph: ViaGraph, name: string, options: ReconcileGraphOptions): ReconcilePlan {
  const resolvedClassified = options.classifiedFields !== undefined
    ? resolveClassifiedFields(name, options.classifiedFields)
    : undefined

  if (resolvedClassified !== undefined && Object.values(resolvedClassified.byField).some((spec) => spec.storage !== 'never')) {
    // A pre-existing depless field whose name collides with one of THIS
    // call's classified rider companions is exempt. Two DIFFERENT existing
    // mechanisms make this safe, depending on whether classified was already
    // attached before this call — the rider-companion collision check in
    // `_applyClassifiedFields` (collection.ts) is NOT unconditional; it sits
    // AFTER that same method's first-wins early return, so it only runs on the
    // FIRST-EVER classified attach: (a) first attach — that collision check
    // runs and refuses the combination outright; (b) classified ALREADY
    // attached — the early return drops THIS call's whole incoming
    // declaration, rider companions included, before the collision check is
    // ever reached, so nothing new is merged for it to collide with. Either
    // way the dangerous state (an opaque depsless computed field silently
    // colliding with a rider name) never forms — no need for this guard to
    // preempt it with a less specific error (`classified/threading.test.ts`'s
    // "reconcile collision" fixture pins case (a)'s exact, more specific,
    // ClassifiedConfigError).
    const riderNames = new Set(Object.keys(resolvedClassified.riderComputed))
    const leaking = [...graph.depslessComputedFields(name)].filter((field) => !riderNames.has(field))
    if (leaking.length > 0) {
      const field = leaking[0]
      throw new ValidationError(
        `Collection "${name}": computed field "${field}" has no declared \`deps\` and the ` +
        `collection declares classified fields — an opaque computed function could silently copy a ` +
        `classified field's plaintext into an ordinary, unredacted field. Declare \`deps\` naming the ` +
        `source fields it reads, e.g. computed: { ${field}: { fn, deps: [...] } }.`,
      )
    }
  }

  const combinedHasClassified = graph.isClassified(name) || resolvedClassified !== undefined

  let edges: readonly GraphEdge[] = []
  let depslessComputedFields: readonly string[] = []
  if (options.computed !== undefined) {
    // #638 Task 7 — `mode: 'virtual'` has no late-attach reconcile door: unlike a
    // materialized entry (folded into `this.computed` by `_applyComputed`, no pipeline
    // rebuild needed), a virtual field needs the computed via-binding to exist in
    // `coll.via.bindings` — which only `compileViaBindings` (construction time) builds.
    // Declaring it here would silently fall through `_applyComputed` and get MATERIALIZED
    // (stored) instead, defeating "never stored". Same construction-only rule as i18nFields/
    // dictKeyFields/viaFields (`ReconcileGraphOptions`'s doc comment).
    for (const [field, entry] of Object.entries(options.computed)) {
      if (computedEntryParts(entry).mode === 'virtual') {
        throw new ValidationError(
          `Collection "${name}": computed field "${field}" declares mode: 'virtual' on a reconcile call — ` +
          `virtual computed fields are construction-only (no late-attach reconcile door); declare them in ` +
          `the collection's first vault.collection("${name}", { ... }) call.`,
        )
      }
    }
    // #638 Task 7 review CRITICAL fix — scoped to THIS reconcile call's own options
    // (mirrors the fresh path's `knownFields`, built once per `vault.collection()` call;
    // `resolveComputedEdges`'s doc comment covers the residual cross-call/known-but-wrong
    // limits).
    const knownFields = collectKnownFieldNames({
      moneyFields: options.moneyFields,
      classifiedFields: resolvedClassified?.byField,
      computed: options.computed,
    })
    edges = resolveComputedEdges(name, options.computed, combinedHasClassified, knownFields)
    const depFields = new Set(edges.map((edge) => edge.target.field))
    depslessComputedFields = Object.keys(options.computed).filter((field) => !depFields.has(field))
  }

  return {
    edges,
    depslessComputedFields,
    classifiedFieldNames: resolvedClassified !== undefined ? Object.keys(resolvedClassified.byField) : [],
  }
}

/**
 * Phase 2 (commit) — call ONLY after every `_apply*` mutation belonging to
 * this reconcile call has succeeded (see {@link validateReconcileGraphEdges}'s
 * doc comment, Finding M2). Registers `plan`'s edges, skipping any target
 * already registered so `registerDerived`'s at-most-once contract holds
 * across repeated identical `vault.collection()` calls, not just within one
 * (Finding I2i); registers the late-attached classified field(s)' sealed
 * posture (Finding M1 — fresh construction gets this for free from
 * `registerCollectionGraphSources`'s compiled-binding loop, which the
 * reconcile path has no equivalent of); and updates the depless-computed /
 * classified graph memory {@link validateReconcileGraphEdges} reads.
 */
export function commitReconcileGraphEdges(graph: ViaGraph, name: string, plan: ReconcilePlan): void {
  for (const edge of plan.edges) {
    // `edge.grain` is always 'record' here — `validateReconcileGraphEdges` refuses any
    // 'virtual' entry before this phase runs (#638 Task 7) — `?? 'record'` mirrors the
    // fresh-construction path's own defaulting for consistency, not because it fires.
    if (!graph.hasDerived(edge.target)) graph.registerDerived(edge.target, edge.sources, 'computed', edge.grain ?? 'record')
  }
  for (const field of plan.depslessComputedFields) graph.markDepslessComputed(name, field)
  for (const field of plan.classifiedFieldNames) graph.registerField(name, field, CLASSIFIED_POSTURE)
  if (plan.classifiedFieldNames.length > 0) graph.markClassified(name)
}

/**
 * Rebuild `coll`'s Via pipeline with the graph's taint overlay layered on
 * (#638 Task 3 — the assignment→enforcement bridge): `postureFor` (query
 * gate + `redactForExport`, `kernel/via-pipeline.ts`) enforces it with zero
 * new surface, and any field the overlay resolves to `encryptedAtRest:
 * 'sealed'` gets the `taint` binding added so it is ACTUALLY sealed at rest
 * via `ctx.sealedSlots` (the same mechanism classified uses).
 *
 * No-op when the collection has no tainted fields — `coll.via` stays exactly
 * what `resolveCollectionConfig` built, preserving `this.via === undefined`
 * for an all-plain collection (#553's sync-stack guarantee). Called once
 * after `registerCollectionGraphSources` (fresh construction) and once after
 * `commitReconcileGraphEdges` (reconcile) — a late-attached classified/
 * computed field can newly taint a field an EARLIER call already built the
 * pipeline for, so both call sites must refresh.
 *
 * Reaches into `coll`'s private `via`/`codec` fields the same way
 * `via-pipeline.ts`'s `exportRedact` and `vault.ts`'s `forget()` already do
 * (grep `_classifySealedShred`/`_writeTombstone`) — no new Collection
 * method, so this never touches the ceiling-locked `collection.ts`. The
 * codec's OWN `via` snapshot (captured at construction, `collection.ts`'s
 * `this.codec = new RecordCodec({..., via: this.via})`) does not
 * automatically follow a later `this.via` reassignment — `RecordCodec.
 * setVia` re-syncs it so `encryptRecord`/`decryptRecord` seal/unseal
 * through the taint binding too, not a stale pre-taint pipeline.
 */
export function applyTaintOverlay(coll: unknown, graph: ViaGraph, name: string): void {
  const postures = buildTaintOverlay(graph.taintedPostures(name), graph.taintSealedFields(name))
  if (!postures) return
  const sealFields = graph.taintSealedFields(name)
  const provenance = graph.taintProvenance(name)
  // #638 Task 7 — a virtual computed field is never sealed (`taintSealedFields` already
  // excludes `grain: 'virtual'` — nothing is stored, so nothing to seal), but a TAINTED
  // one (exportable:false, i.e. its deps include a classified/sealed source) still needs
  // its value replaced on every READ: `present()` is the only place a virtual field's
  // value ever exists (never stored, so `redactForExport`'s export-only pass is not
  // enough — the plain `get()`/`list()` path must be closed too).
  const virtualFields = graph.virtualFields(name)
  const virtualExportRedact = new Set<string>()
  for (const [field, posture] of postures) {
    if (posture.exportable === false && virtualFields.has(field)) virtualExportRedact.add(field)
  }
  const c = coll as { via: ViaPipeline | undefined; codec: { setVia(via: ViaPipeline | undefined): void } }
  const needsTaintBinding = sealFields.size > 0 || virtualExportRedact.size > 0
  const bindings = needsTaintBinding
    ? [...(c.via?.bindings ?? []), taintBinding(sealFields, virtualExportRedact)]
    : (c.via?.bindings ?? [])
  const taint: ViaTaintOverlay = { postures, sealFields, provenance }
  c.via = ViaPipeline.build(bindings, taint)
  c.codec.setVia(c.via)
}
