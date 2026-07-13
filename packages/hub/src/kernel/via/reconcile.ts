/**
 * kernel/via/reconcile.ts — #664 the late-attach reconcile-path dispatch.
 *
 * `vault.ts`'s reconcile branch (a SECOND-OR-LATER `vault.collection(name, {...})` call on an
 * already-open collection) used to be a flat 5-branch `if (coll && X) coll._applyX(...)` ladder
 * with no collision guard and no i18n/dictKey machinery at all (i18nFields/dictKeyFields were
 * silently ignored on re-open — only the fresh-construction branch ever wired them). This module
 * moves that whole ladder OUT of `vault.ts` (a kernel-surface-ceiling-guarded file) into ONE
 * dispatch entry point, {@link reconcileViaAttach}, that:
 *
 *  1. runs the late-attach collision guard ({@link guardReconcileCollisions}, via/compose.ts)
 *     BEFORE any mutation — both the incoming×incoming and existing×incoming recipes;
 *  2. routes the FIVE pre-existing reconciles (money/computed/fieldMeta/meta/classified) through
 *     their unchanged `Collection._applyX` methods (collection.ts is NOT touched — this dispatch
 *     only orchestrates, matching the pre-#664 call order exactly);
 *  3. commits the two-phase graph-edge reconcile (`via/graph-wiring.ts`) + taint overlay, exactly
 *     as before;
 *  4. wires i18n/dictKey late-attach via {@link reconcileI18nFields}/{@link reconcileDictKeyFields}
 *     — rebuilding the pipeline through {@link Collection._setVia} (#666's writer seam), mirroring
 *     the fresh-construction wiring (`collection-config.ts#compileViaBindings`'s i18n slot +
 *     `vault.ts`'s registry population) without duplicating it in a second place;
 *  5. (#664 Part 2b) wires lookup()/enumOf()/dict() late-attach via {@link reconcileLookupFields}
 *     — tier-scoped: enum/static tiers are a clean, self-contained attach; the reserved (dict)
 *     tier additionally updates the SAME vault registries the fresh path populates
 *     (`dictKeyFieldRegistry`/`reservedLookupCollections`/`staticDescriptorByField`/`staticByName`/
 *     `staticDictNames`, via `collectLookupDictCompat`); the matrix (`backing:'collection'`) tier
 *     is gated by {@link refuseUnattachableMatrixLookupFields} — refuses with a `ValidationError`
 *     unless the backing collection is already open (this vault session) and prefetch-enabled.
 *
 * `ViaReconcileVaultCtx` takes the vault-resident registry Maps/closures the i18n/dictKey wiring
 * needs as a plain structural bag of ARGUMENTS (mirroring `via/lookup/registry.ts`'s own
 * "#650 Task 1" extraction pattern) — never a `Vault` import (this file is part of the kernel
 * spine's `port/with/`-only import discipline — S5 port-layering, `scripts/check-architecture.mjs`
 * `checkPortLayering`), so `vault.ts` passes `this` once its relevant fields are readable from
 * outside the class (see `Vault`'s field declarations).
 */
import type { Collection } from '../collection.js'
import { ViaPipeline, type HasWritableViaPipeline } from './pipeline.js'
import { viaBinder, type ViaBinding } from './index.js'
import { guardReconcileCollisions, type MergedViaFields } from './compose.js'
import type { ViaGraph } from './graph.js'
import {
  validateReconcileGraphEdges, commitReconcileGraphEdges, applyTaintOverlay,
  type ReconcileGraphOptions,
} from './graph-wiring.js'
import { ValidationError } from '../errors.js'
import { resolveClassifiedFields } from '../../port/with/classified-strategy.js'
import {
  isStaticDictDescriptor,
  type I18nStrategy, type I18nTextDescriptor, type DictKeyDescriptor, type StaticDictDescriptor, type DictionaryHandle,
} from '../../port/with/i18n-strategy.js'
import {
  resolveLabelFromMap, dictCollectionName, collectLookupDictCompat, checkLookupMembership, buildLookupAltIndex,
  buildLookupSnapshotRows, registerLookupRefEdges, type LookupDescriptor,
} from '../../port/with/lookup-strategy.js'

type AnyCollection = Collection<Record<string, unknown>>

/**
 * Structural reconcile-capable collection handle: `_via`/`_setVia` (#666's writer seam) plus the
 * five pre-existing `_applyX` late-attach methods (#623/#629/#638). Every parameter type is
 * DERIVED off `Collection` itself via `Parameters<...>` rather than imported by name — several
 * (`FieldMeta`, `CollectionMeta`, `ComputedFields`) are with-* service types the kernel spine may
 * not statically import (S5 port-layering); deriving them off the already-typed `Collection`
 * method avoids a second, duplicate type declaration too (mirrors `via/graph-wiring.ts`'s
 * `ComputedFieldsParam` trick).
 */
export interface ReconcilableCollection extends HasWritableViaPipeline {
  _applyMoneyFields(moneyFields: Parameters<AnyCollection['_applyMoneyFields']>[0]): void
  _applyComputed(computed: Parameters<AnyCollection['_applyComputed']>[0]): void
  _applyFieldMeta(fieldMeta: Parameters<AnyCollection['_applyFieldMeta']>[0]): void
  _applyMeta(meta: Parameters<AnyCollection['_applyMeta']>[0]): void
  _applyClassifiedFields(classifiedFields: Parameters<AnyCollection['_applyClassifiedFields']>[0]): void
}

/** The vault-resident state/closures the i18n/dictKey late-attach wiring reads and writes —
 *  the SAME registries `vault.ts`'s fresh-construction branch populates (`i18nFieldRegistry`
 *  :884-886, the dictKeyFields split :903-940, `dictLabelResolver`/`i18nPutValidator`/
 *  `autoTranslateHook` :1111-1155), passed as plain values (never `this: Vault`) so this module
 *  never imports the `Vault` class. */
export interface ViaReconcileVaultCtx {
  readonly i18nStrategy: I18nStrategy
  /** — named `locale`, not `defaultLocale`, to match `Vault`'s own field name 1:1 (so `this`
   *  satisfies this interface structurally with zero adapter object at the call site). */
  readonly locale: string | undefined
  readonly translateText:
    | ((text: string, from: string, to: string, field: string, collection: string) => Promise<string>)
    | undefined
  readonly i18nFieldRegistry: Map<string, Record<string, I18nTextDescriptor>>
  readonly dictKeyFieldRegistry: Map<string, Record<string, string>>
  readonly staticDescriptorByField: Map<string, Record<string, StaticDictDescriptor>>
  readonly reservedLookupCollections: Map<string, string>
  readonly staticByName: Map<string, StaticDictDescriptor>
  readonly staticDictNames: Set<string>
  dictionary(name: string): DictionaryHandle
  enforceI18nOnPut(collectionName: string, record: unknown): void
  enforceStaticDictOnPut(collectionName: string, record: unknown): void
  /** #664 Part 2b — the matrix-tier lookup late-attach gate: "is this dimension already open in
   *  this vault session" (never constructs a fresh collection) — `Vault._getCollection`. */
  getOpenCollection(name: string): AnyCollection | undefined
  /** #664 Part 2b — the vault's CONSTRUCTING collection accessor the lookup binding's lazy
   *  closures (`getLookupBacking`/`membership`/`getAltIndex`/`snapshotFor`) read through — mirrors
   *  `vault.ts`'s fresh-construct `(n) => this.collection<Record<string, unknown>>(n)` closure
   *  verbatim. Only ever invoked, for a matrix-tier dimension, once {@link getOpenCollection}'s
   *  gate has already confirmed it is open — never the door that opens it. */
  getCollection(name: string): AnyCollection
}

function hasI18nBinding(coll: ReconcilableCollection): boolean {
  return (coll._via?.bindings ?? []).some((b) => b.brand === 'i18n')
}

/** money-after / lookup-before — the SAME slot `compileViaBindings` (collection-config.ts)
 *  compiles the i18n binding into (money→i18n→lookup→classified→blob→computed, taint appended
 *  last by `applyTaintOverlay`). Late-attach only ever INSERTS one i18n binding (first-wins —
 *  see {@link hasI18nBinding}), so a plain "before the first post-i18n family" scan is enough;
 *  no money-prepend/classified-append juggling like `_applyMoneyFields`/`_applyClassifiedFields`
 *  need (those two mutate around an i18n binding that might already be there; i18n itself never
 *  needs to reorder around a LATER family, since none of money/i18n/lookup/classified/blob/
 *  computed's own late-attach paths re-sort on insert). */
function insertI18nBinding(existing: readonly ViaBinding[], i18nBinding: ViaBinding): ViaBinding[] {
  const idx = existing.findIndex((b) =>
    b.brand === 'lookup' || b.brand === 'classified' || b.brand === 'blob' || b.brand === 'computed' || b.brand === 'taint')
  return idx === -1 ? [...existing, i18nBinding] : [...existing.slice(0, idx), i18nBinding, ...existing.slice(idx)]
}

function hasLookupBinding(coll: ReconcilableCollection): boolean {
  return (coll._via?.bindings ?? []).some((b) => b.brand === 'lookup')
}

/** lookup slots right after i18n, before classified/blob/computed/taint — the SAME
 *  money→i18n→lookup→classified→blob→computed compile order (collection-config.ts:554).
 *  Late-attach only ever inserts ONE lookup binding (first-wins — see {@link hasLookupBinding}),
 *  so scanning for the first binding that must come AFTER lookup is enough (mirrors
 *  {@link insertI18nBinding}'s own reasoning); an i18n binding present at insert time is already
 *  earlier in `existing` (either compiled fresh, or late-attached by an EARLIER reconcile call —
 *  {@link insertI18nBinding}'s own stop-list includes `'lookup'`, so the reverse ordering is
 *  symmetric regardless of which family attaches first). */
function insertLookupBinding(existing: readonly ViaBinding[], lookupBindingObj: ViaBinding): ViaBinding[] {
  const idx = existing.findIndex((b) => b.brand === 'classified' || b.brand === 'blob' || b.brand === 'computed' || b.brand === 'taint')
  return idx === -1 ? [...existing, lookupBindingObj] : [...existing.slice(0, idx), lookupBindingObj, ...existing.slice(idx)]
}

/**
 * #664 Part 2b — the matrix (`backing:'collection'`) tier's late-attach gate. Unlike enum/static
 * (self-contained) or reserved (vault-registry-backed), matrix reads ANOTHER live collection's
 * cache via `querySourceForJoin()` — `getLookupBacking`/`membership`/`getAltIndex`/`snapshotFor`
 * (built below in {@link reconcileLookupFields}) are all vault-built closures that stay lazy,
 * mirroring the fresh-construct path exactly. At FRESH construction that laziness is harmless —
 * the backing dimension may simply not exist yet, and the closures only ever fire once it does.
 * A LATE attach is different: the vault is already mid-session, so silently deferring would let a
 * matrix field attach onto a dimension that never opens (or opens lazy) this session, surfacing
 * the confusing join-branded lazy-mode error on some UNRELATED later put()/read() instead of at
 * the point of declaration — the exact silent-deferral failure class `getAltIndexOrThrow`
 * (`via/lookup/binding.ts:252-264`) already refuses for altKeys specifically. This closes it
 * for the field's very existence: REFUSE eagerly, at attach time, with a `ValidationError` naming
 * the field, the dimension, and the remedy, unless the backing dimension is ALREADY open (in THIS
 * vault session — `vaultCtx.getOpenCollection`, which never constructs) AND prefetch-enabled
 * (probed via `querySourceForJoin()` itself — the SAME lazy-mode signal `getAltIndexOrThrow`
 * reads, never a private `Collection` field reach-around; `collection.ts` is untouched by #664).
 *
 * Callers MUST run this BEFORE any `_apply*` mutation for the WHOLE reconcile call (Finding-M2
 * ordering law, `via/graph-wiring.ts#validateReconcileGraphEdges`'s doc comment) — see
 * {@link reconcileViaAttach}'s own early call, which runs this ahead of money/computed/classified
 * apply so a combined call (e.g. `moneyFields` + a not-yet-open matrix `lookupFields` entry) never
 * partially mutates money state before the whole call is refused. Also re-run at the top of
 * {@link reconcileLookupFields} itself (cheap, pure, idempotent) so a direct/standalone caller of
 * that function stays self-protecting too.
 */
function refuseUnattachableMatrixLookupFields(
  vaultCtx: ViaReconcileVaultCtx,
  lookupFields: Record<string, LookupDescriptor>,
): void {
  for (const [field, desc] of Object.entries(lookupFields)) {
    if (desc.backing !== 'collection') continue
    const backing = vaultCtx.getOpenCollection(desc.dimension)
    if (!backing) {
      throw new ValidationError(
        `lookup: matrix field "${field}" (backing dimension "${desc.dimension}") cannot be late-attached — ` +
        `"${desc.dimension}" is not open in this vault session yet. Open it first, e.g. ` +
        `vault.collection('${desc.dimension}', { ... }), with prefetch enabled (the default) before ` +
        `attaching "${field}" via a later vault.collection() call.`,
      )
    }
    try {
      backing.querySourceForJoin()
    } catch (err) {
      if (err instanceof Error && err.message.includes('lazy-mode')) {
        throw new ValidationError(
          `lookup: matrix field "${field}" (backing dimension "${desc.dimension}") cannot be late-attached — ` +
          `"${desc.dimension}" is open in lazy mode ({ prefetch: false }). Re-open "${desc.dimension}" ` +
          `without { prefetch: false } (eager mode, the default) before attaching "${field}".`,
        )
      }
      throw err
    }
  }
}

/** Mirrors `vault.ts`'s `collOpts.dictLabelResolver` closure (:1117-1125) verbatim — a static
 *  dict resolves from its in-memory table, a plain dictKey resolves through the encrypted
 *  `_dict_*` handle. */
function buildDictLabelResolver(vaultCtx: ViaReconcileVaultCtx) {
  return async (dictName: string, key: string, locale: string, fallback?: string | readonly string[]): Promise<string | undefined> => {
    const stat = vaultCtx.staticByName.get(dictName)
    if (stat) {
      const labels = stat.table[key]
      return labels ? resolveLabelFromMap(labels, locale, fallback) : undefined
    }
    return vaultCtx.dictionary(dictName).resolveLabel(key, locale, fallback)
  }
}

/** Mirrors `vault.ts`'s dictKeyFields registry-population loop (:909-939) — split into the
 *  rename-tracked (`dictKeyFieldRegistry`) vs static-table (`staticDescriptorByField`) forms,
 *  registering each referenced dictionary into `reservedLookupCollections` for sync. */
function registerDictKeyRegistries(
  vaultCtx: ViaReconcileVaultCtx, name: string,
  dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor>,
): void {
  const dictFieldMap: Record<string, string> = {}
  const staticFieldMap: Record<string, StaticDictDescriptor> = {}
  for (const [field, desc] of Object.entries(dictKeyFields)) {
    if (isStaticDictDescriptor(desc)) {
      staticFieldMap[field] = desc
      vaultCtx.staticDictNames.add(desc.name)
      vaultCtx.staticByName.set(desc.name, desc)
    } else {
      dictFieldMap[field] = desc.name
    }
  }
  if (Object.keys(dictFieldMap).length > 0) {
    vaultCtx.dictKeyFieldRegistry.set(name, dictFieldMap)
    for (const dictName of new Set(Object.values(dictFieldMap))) {
      vaultCtx.reservedLookupCollections.set(dictCollectionName(dictName), dictName)
    }
  }
  if (Object.keys(staticFieldMap).length > 0) {
    vaultCtx.staticDescriptorByField.set(name, staticFieldMap)
  }
}

/** Mirrors `compileViaBindings`'s i18n slot (collection-config.ts:702-723) — same densify-subset
 *  computation, same config shape handed to `viaBinder('i18n')`. `defaultPosture`/taint is
 *  preserved across the rebuild (unlike `_applyMoneyFields`/`_applyClassifiedFields`, which drop
 *  it — those rely on a same-call `applyTaintOverlay` re-run when computed/classifiedFields is
 *  also present; i18n/dictKey have no such re-run, so dropping it here would silently un-taint an
 *  already-tainted field on a collection that happens to ALSO gain i18n late). */
function rebuildI18nBinding(
  coll: ReconcilableCollection, vaultCtx: ViaReconcileVaultCtx, name: string,
  i18nFields: Record<string, I18nTextDescriptor> | undefined,
  dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined,
): void {
  const densify = i18nFields
    ? Object.fromEntries(Object.entries(i18nFields).filter(([, d]) => d.options.densifyOnWrite === true))
    : {}
  const i18nDensifyFields = Object.keys(densify).length > 0 ? densify : undefined
  const binding = viaBinder('i18n')({
    ...(i18nFields !== undefined ? { i18nFields } : {}),
    ...(dictKeyFields !== undefined ? { dictKeyFields } : {}),
    ...(i18nDensifyFields !== undefined ? { i18nDensifyFields } : {}),
    strategy: vaultCtx.i18nStrategy,
    ...(vaultCtx.locale !== undefined ? { defaultLocale: vaultCtx.locale } : {}),
    ...(i18nFields !== undefined && vaultCtx.translateText !== undefined ? { autoTranslateHook: vaultCtx.translateText } : {}),
    ...(dictKeyFields !== undefined ? { dictLabelResolver: buildDictLabelResolver(vaultCtx) } : {}),
    i18nPutValidator: (record: unknown) => { vaultCtx.enforceI18nOnPut(name, record); vaultCtx.enforceStaticDictOnPut(name, record) },
    collectionName: name,
  })
  const existing = coll._via?.bindings ?? []
  coll._setVia(ViaPipeline.build(insertI18nBinding(existing, binding), coll._via?.taint))
}

/**
 * #664 Part 2 — late-attach i18nText fields. First-wins (mirrors `_applyMoneyFields`'s own
 * first-wins convention): a no-op once the collection already has an 'i18n' binding, whether
 * that binding came from fresh construction or an earlier reconcile call. `dictKeyFields` is an
 * optional SECOND family arriving in the SAME `vault.collection()` call (`mergeViaFields` already
 * combined them for this one call) — passed through so ONE binding rebuild covers both, exactly
 * like `compileViaBindings` builds ONE 'i18n' binding from both maps at fresh construction.
 */
export function reconcileI18nFields(
  coll: ReconcilableCollection, vaultCtx: ViaReconcileVaultCtx, name: string,
  i18nFields: Record<string, I18nTextDescriptor> | undefined,
  dictKeyFields?: Record<string, DictKeyDescriptor | StaticDictDescriptor>,
): void {
  if (i18nFields === undefined) return
  if (hasI18nBinding(coll)) return
  vaultCtx.i18nFieldRegistry.set(name, i18nFields)
  if (dictKeyFields !== undefined) registerDictKeyRegistries(vaultCtx, name, dictKeyFields)
  rebuildI18nBinding(coll, vaultCtx, name, i18nFields, dictKeyFields)
}

/**
 * #664 Part 2 — late-attach dictKeyFields (dictKey()/staticDict()) with NO i18nFields in the same
 * call — the dictKey-only late-attach door. First-wins, same convention as
 * {@link reconcileI18nFields} (and, transitively, a no-op if that sibling function already
 * handled a combined i18nFields+dictKeyFields call for this collection).
 */
export function reconcileDictKeyFields(
  coll: ReconcilableCollection, vaultCtx: ViaReconcileVaultCtx, name: string,
  dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined,
): void {
  if (dictKeyFields === undefined) return
  if (hasI18nBinding(coll)) return
  registerDictKeyRegistries(vaultCtx, name, dictKeyFields)
  rebuildI18nBinding(coll, vaultCtx, name, undefined, dictKeyFields)
}

/**
 * #664 Part 2b — late-attach lookup()/enumOf()/dict() fields, tier-scoped (issue #664, spec-
 * ratified tier policy):
 *
 *  - **enum** (`backing:'static'`, no `table`) / **static** (`+table`) — self-contained:
 *    membership/labels come from the declared `keys`/`table` alone, no vault registry touch, no
 *    cross-collection read. Clean attach, same shape as i18n/dictKey's own reconcile door.
 *  - **reserved** (`dict()` / `lookup(dim, { backing:'reserved' })`) — additionally registers into
 *    the SAME vault registries the fresh path populates (`vault.ts`'s dictKeyFields/lookupFields
 *    registry-population loop) — `dictKeyFieldRegistry`/`reservedLookupCollections` for a bare
 *    dict field; `staticDescriptorByField`/`staticByName`/`staticDictNames` for a table-bearing
 *    static field — via `collectLookupDictCompat` (#650 Task 2's alias-equivalence bridge, the
 *    SAME helper the fresh path already calls), reused verbatim, not duplicated.
 *  - **matrix** (`backing:'collection'`) — gated by {@link refuseUnattachableMatrixLookupFields}.
 *
 * First-wins (mirrors {@link reconcileI18nFields}): a no-op once the collection already has a
 * 'lookup' binding, whether from fresh construction or an earlier reconcile call.
 *
 * Post-attach, registers the SAME cross-collection `'ref'` graph edges the fresh path does
 * (`registerLookupRefEdges` — internally skips the static tier, which has no backing collection to
 * reference-check) — `ViaGraph.referencingEdgesOf` sees them immediately, so delete-time
 * restrict/cascade/nullify semantics are live post-attach too, same as a fresh declaration.
 */
export function reconcileLookupFields(
  coll: ReconcilableCollection, vaultCtx: ViaReconcileVaultCtx, graph: ViaGraph, name: string,
  lookupFields: Record<string, LookupDescriptor> | undefined,
): void {
  if (lookupFields === undefined) return
  if (hasLookupBinding(coll)) return
  refuseUnattachableMatrixLookupFields(vaultCtx, lookupFields) // standalone-caller safety net — see its own doc comment

  const compat = collectLookupDictCompat(lookupFields)
  if (Object.keys(compat.dictFieldMap).length > 0) {
    vaultCtx.dictKeyFieldRegistry.set(name, { ...(vaultCtx.dictKeyFieldRegistry.get(name) ?? {}), ...compat.dictFieldMap })
    for (const dictName of new Set(Object.values(compat.dictFieldMap))) {
      vaultCtx.reservedLookupCollections.set(dictCollectionName(dictName), dictName)
    }
  }
  if (compat.staticEntries.length > 0) {
    const staticFieldMap = { ...(vaultCtx.staticDescriptorByField.get(name) ?? {}) }
    for (const [field, desc] of compat.staticEntries) {
      staticFieldMap[field] = desc
      vaultCtx.staticDictNames.add(desc.name)
      vaultCtx.staticByName.set(desc.name, desc)
    }
    vaultCtx.staticDescriptorByField.set(name, staticFieldMap)
  }

  // must move together with collection-config.ts:642-651's lookup slot (#664) — same
  // viaBinder('lookup') option-shape contract.
  const binding = viaBinder('lookup')({
    lookupFields,
    // must move together with vault.ts:1133-1139's five lookup closures (#664) — same
    // lookupLabelResolver/getLookupBacking/membership/getAltIndex/snapshotFor construction.
    lookupLabelResolver: buildDictLabelResolver(vaultCtx),
    getLookupBacking: (desc: LookupDescriptor) => async (key: string) =>
      buildLookupSnapshotRows(desc, (n) => vaultCtx.reservedLookupCollections.has(dictCollectionName(n)), (n) => vaultCtx.dictionary(n), (n) => vaultCtx.getCollection(n))?.get(key) ??
        (desc.key === 'id' ? ((await vaultCtx.getCollection(desc.dimension).get(key)) ?? undefined) : undefined),
    membership: (field: string, key: string) => checkLookupMembership(lookupFields[field]!, key, (n) => vaultCtx.dictionary(n), (n) => vaultCtx.getCollection(n)),
    getAltIndex: (d: LookupDescriptor) => buildLookupAltIndex(d, (n) => vaultCtx.dictionary(n), (n) => vaultCtx.getCollection(n)),
    snapshotFor: (d: LookupDescriptor) =>
      buildLookupSnapshotRows(d, (n) => vaultCtx.reservedLookupCollections.has(dictCollectionName(n)), (n) => vaultCtx.dictionary(n), (n) => vaultCtx.getCollection(n)),
    collectionName: name,
  })
  const existing = coll._via?.bindings ?? []
  coll._setVia(ViaPipeline.build(insertLookupBinding(existing, binding), coll._via?.taint))
  registerLookupRefEdges(graph, name, lookupFields)
}

/** The late-attach reconcile call's field-declaring options — the slice of `vault.collection()`'s
 *  `options` a reconcile call may carry, plus the `mergeViaFields` output that feeds both the
 *  guard and the money/i18n/dictKey/lookup reconciles. `blobFields` has no `_apply*` door (guard
 *  visibility only — an incoming×incoming collision with `blobFields` must still refuse, even
 *  though a bare blobFields late-attach is otherwise silently inert, matching pre-#664 behavior). */
export interface ReconcileLateAttachPlan {
  readonly effectiveViaFields: MergedViaFields
  readonly computed?: Parameters<AnyCollection['_applyComputed']>[0]
  readonly fieldMeta?: Parameters<AnyCollection['_applyFieldMeta']>[0]
  readonly meta?: Parameters<AnyCollection['_applyMeta']>[0]
  readonly classifiedFields?: Parameters<AnyCollection['_applyClassifiedFields']>[0]
  readonly blobFields?: Record<string, unknown>
}

/**
 * #664 — the ONE late-attach reconcile dispatch `vault.ts` calls, replacing its former 5-branch
 * `_apply*` ladder. Order: guard (before any mutation) → the matrix-tier lookup gate (also before
 * any mutation — see below) → the five pre-existing reconciles, UNCHANGED call order/semantics →
 * graph-edge commit + taint overlay (unchanged) → i18n/dictKey → lookup (#664 Part 2b).
 */
export function reconcileViaAttach(
  coll: ReconcilableCollection, graph: ViaGraph, name: string,
  vaultCtx: ViaReconcileVaultCtx, plan: ReconcileLateAttachPlan,
): void {
  guardReconcileCollisions(coll._via, {
    moneyFields: plan.effectiveViaFields.moneyFields,
    i18nFields: plan.effectiveViaFields.i18nFields,
    dictKeyFields: plan.effectiveViaFields.dictKeyFields,
    lookupFields: plan.effectiveViaFields.lookupFields,
    classifiedFields: plan.classifiedFields !== undefined ? resolveClassifiedFields(name, plan.classifiedFields).byField : undefined,
    blobFields: plan.blobFields,
    computed: { ...(plan.computed ?? {}), ...(plan.effectiveViaFields.computedFields ?? {}) },
  })
  // #664 Part 2b — the matrix-tier lookup gate must run here, BEFORE money/computed/classified
  // apply below (Finding-M2 ordering law — see `refuseUnattachableMatrixLookupFields`'s own doc
  // comment): deferring it to `reconcileLookupFields`'s own call site near the bottom of this
  // function would let a combined call (e.g. `moneyFields` + a not-yet-open matrix `lookupFields`
  // entry) partially mutate money state before the whole call is ultimately refused.
  if (plan.effectiveViaFields.lookupFields !== undefined && !hasLookupBinding(coll)) {
    refuseUnattachableMatrixLookupFields(vaultCtx, plan.effectiveViaFields.lookupFields)
  }

  const reconcilePlan = (plan.computed || plan.classifiedFields)
    ? validateReconcileGraphEdges(graph, name, {
        // `moneyFields` here is the MERGED view (`plan.effectiveViaFields.moneyFields`), not the
        // raw incoming `moneyFields` option — intentional (controller ruling, #664a review): a
        // via()-spelled money field must count in this call's `knownFields` for computed `deps`
        // validation exactly like a sugar-keyed one does, the #627-consistent semantics. Pre-#664
        // this reconciled via a blind `options as unknown as ReconcileGraphOptions` cast, which
        // silently read the RAW option instead — never intentional, just uncovered before now.
        moneyFields: plan.effectiveViaFields.moneyFields, classifiedFields: plan.classifiedFields, computed: plan.computed,
      } as ReconcileGraphOptions)
    : undefined

  if (plan.effectiveViaFields.moneyFields) coll._applyMoneyFields(plan.effectiveViaFields.moneyFields)
  if (plan.computed) coll._applyComputed(plan.computed)
  if (plan.fieldMeta) coll._applyFieldMeta(plan.fieldMeta)
  if (plan.meta) coll._applyMeta(plan.meta)
  if (plan.classifiedFields) coll._applyClassifiedFields(plan.classifiedFields)
  if (reconcilePlan) {
    commitReconcileGraphEdges(graph, name, reconcilePlan)
    applyTaintOverlay(coll, graph, name)
  }
  if (plan.effectiveViaFields.i18nFields !== undefined) {
    reconcileI18nFields(coll, vaultCtx, name, plan.effectiveViaFields.i18nFields, plan.effectiveViaFields.dictKeyFields)
  } else if (plan.effectiveViaFields.dictKeyFields !== undefined) {
    reconcileDictKeyFields(coll, vaultCtx, name, plan.effectiveViaFields.dictKeyFields)
  }
  // Deliberately a separate `if`, not another `else if` on the i18n/dictKey pair above: lookup is
  // a THIRD, independent binding family (compileViaBindings compiles it in its own `if
  // (lookupFields !== undefined)` block, collection-config.ts:642-651 — not folded into the i18n
  // binding the way dictKeyFields is) — a single `vault.collection()` call may legally declare
  // BOTH i18nFields (or dictKeyFields) on one field AND lookupFields on another, and chaining this
  // onto the SAME else-if ladder would silently drop the lookupFields half of such a call.
  if (plan.effectiveViaFields.lookupFields !== undefined) {
    reconcileLookupFields(coll, vaultCtx, graph, name, plan.effectiveViaFields.lookupFields)
  }
}
