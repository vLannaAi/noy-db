/**
 * kernel/via-reconcile.ts — #664 the late-attach reconcile-path dispatch.
 *
 * `vault.ts`'s reconcile branch (a SECOND-OR-LATER `vault.collection(name, {...})` call on an
 * already-open collection) used to be a flat 5-branch `if (coll && X) coll._applyX(...)` ladder
 * with no collision guard and no i18n/dictKey machinery at all (i18nFields/dictKeyFields were
 * silently ignored on re-open — only the fresh-construction branch ever wired them). This module
 * moves that whole ladder OUT of `vault.ts` (a kernel-surface-ceiling-guarded file) into ONE
 * dispatch entry point, {@link reconcileViaAttach}, that:
 *
 *  1. runs the late-attach collision guard ({@link guardReconcileCollisions}, via-compose.ts)
 *     BEFORE any mutation — both the incoming×incoming and existing×incoming recipes;
 *  2. routes the FIVE pre-existing reconciles (money/computed/fieldMeta/meta/classified) through
 *     their unchanged `Collection._applyX` methods (collection.ts is NOT touched — this dispatch
 *     only orchestrates, matching the pre-#664 call order exactly);
 *  3. commits the two-phase graph-edge reconcile (`via-graph-wiring.ts`) + taint overlay, exactly
 *     as before;
 *  4. NEWLY wires i18n/dictKey late-attach via {@link reconcileI18nFields}/
 *     {@link reconcileDictKeyFields} — rebuilding the pipeline through {@link Collection._setVia}
 *     (#666's writer seam), mirroring the fresh-construction wiring
 *     (`collection-config.ts#compileViaBindings`'s i18n slot + `vault.ts`'s registry population)
 *     without duplicating it in a second place. lookupFields reconcile is a SEPARATE, later task
 *     — the `plan`/dispatch shape below is deliberately structured so a `reconcileLookupFields`
 *     branch slots in alongside i18n/dictKey without reshaping this function.
 *
 * `ViaReconcileVaultCtx` takes the vault-resident registry Maps/closures the i18n/dictKey wiring
 * needs as a plain structural bag of ARGUMENTS (mirroring `shape/via-lookup/registry.ts`'s own
 * "#650 Task 1" extraction pattern) — never a `Vault` import (this file is part of the kernel
 * spine's `port/with/`-only import discipline — S5 port-layering, `scripts/check-architecture.mjs`
 * `checkPortLayering`), so `vault.ts` passes `this` once its relevant fields are readable from
 * outside the class (see `Vault`'s field declarations).
 */
import type { Collection } from './collection.js'
import { ViaPipeline, type HasWritableViaPipeline } from './via-pipeline.js'
import { viaBinder, type ViaBinding } from './via.js'
import { guardReconcileCollisions, type MergedViaFields } from './via-compose.js'
import type { ViaGraph } from './via-graph.js'
import {
  validateReconcileGraphEdges, commitReconcileGraphEdges, applyTaintOverlay,
  type ReconcileGraphOptions,
} from './via-graph-wiring.js'
import { resolveClassifiedFields } from '../port/with/classified-strategy.js'
import {
  isStaticDictDescriptor,
  type I18nStrategy, type I18nTextDescriptor, type DictKeyDescriptor, type StaticDictDescriptor, type DictionaryHandle,
} from '../port/with/i18n-strategy.js'
import { resolveLabelFromMap, dictCollectionName } from '../port/with/lookup-strategy.js'

type AnyCollection = Collection<Record<string, unknown>>

/**
 * Structural reconcile-capable collection handle: `_via`/`_setVia` (#666's writer seam) plus the
 * five pre-existing `_applyX` late-attach methods (#623/#629/#638). Every parameter type is
 * DERIVED off `Collection` itself via `Parameters<...>` rather than imported by name — several
 * (`FieldMeta`, `CollectionMeta`, `ComputedFields`) are with-* service types the kernel spine may
 * not statically import (S5 port-layering); deriving them off the already-typed `Collection`
 * method avoids a second, duplicate type declaration too (mirrors `via-graph-wiring.ts`'s
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
 * `_apply*` ladder. Order: guard (before any mutation) → the five pre-existing reconciles,
 * UNCHANGED call order/semantics → graph-edge commit + taint overlay (unchanged) → i18n/dictKey
 * (new). `lookupFields` is intentionally NOT dispatched here yet — a future
 * `reconcileLookupFields` branch slots in as one more `else if` on `plan.effectiveViaFields.lookupFields`
 * without touching anything above it.
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
}
