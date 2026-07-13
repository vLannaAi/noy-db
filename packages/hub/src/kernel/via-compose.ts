/**
 * via() — the public composer for declaring a field's Via-bound feature(s)
 * directly, as an alternative to a feature's dedicated sugar key
 * (`moneyFields`/`i18nFields`/`dictKeyFields`). Wraps one or more
 * `ViaDescriptor`s (`money()`, `i18nText()`, `dictKey()`, `staticDict()`, …)
 * into a single tagged container a collection's `viaFields` option can hold.
 *
 * Declaring a field via `via()` is equivalent to declaring the same
 * descriptor under its feature's sugar key — `compileViaBindings`
 * (kernel/collection-config.ts) groups a `viaFields` map by each
 * descriptor's `_viaBrand` and merges it with the sugar keys, throwing when
 * the same field is declared in both places (#623 Task 9).
 */
import { ValidationError } from './errors.js'
import type { ViaBinding, ViaDescriptor } from './via.js'
import type { ViaPipeline } from './via-pipeline.js'
// Types + shape-classification predicates reach through the kernel's own
// `port/with/` hook seam (never `src/shape/` directly) — #623 Task 11.
// `isI18nTextDescriptor`/`isDictKeyDescriptor` are pure tag checks moved
// onto the port alongside `isStaticDictDescriptor` (see i18n-strategy.ts);
// the descriptor types were already port-owned re-exports (#623 Task 8).
import type { DictKeyDescriptor, I18nTextDescriptor, StaticDictDescriptor } from '../port/with/i18n-strategy.js'
import { isDictKeyDescriptor, isI18nTextDescriptor, isStaticDictDescriptor } from '../port/with/i18n-strategy.js'
// `ComputedDescriptor` is a type-only need — the eager link that makes
// `viaBinder('computed')` resolvable lives in `collection-config.ts`'s value
// import of this same port module (#638 Task 7).
import type { ComputedDescriptor } from '../port/with/computed-strategy.js'
// #650 Task 2 — `LookupDescriptor`/`isLookupDescriptor` reach through the
// SAME kernel port seam (no new `src/shape/**` specifier here; `linkLookupVia()`
// already ran when the caller constructed the descriptor via `lookup()`/
// `enumOf()`/`dict()`, so `viaBinder('lookup')` is resolvable with no eager
// import needed here, mirroring i18n/money — see `descriptor.ts`).
import type { LookupDescriptor } from '../port/with/lookup-strategy.js'
import { isLookupDescriptor } from '../port/with/lookup-strategy.js'

/** Tagged container returned by {@link via}. Readonly — never mutated after construction. */
export interface ViaFieldSpec {
  readonly _noydbVia: true
  readonly descriptors: readonly ViaDescriptor[]
}

/**
 * Compose one or more Via feature descriptors for a single field.
 *
 * @example
 * ```ts
 * vault.collection('invoices', {
 *   viaFields: { total: via(money({ currency: 'EUR' })) },
 * })
 * ```
 */
export function via(...descriptors: ViaDescriptor[]): ViaFieldSpec {
  if (descriptors.length === 0) {
    throw new ValidationError('via(): at least one descriptor is required, e.g. via(money({ currency: \'EUR\' }))')
  }
  return { _noydbVia: true, descriptors }
}

/** Runtime predicate for detecting a {@link ViaFieldSpec}. */
export function isViaFieldSpec(x: unknown): x is ViaFieldSpec {
  return typeof x === 'object' && x !== null && (x as { _noydbVia?: unknown })._noydbVia === true
}

/** The money/i18n/lookup sugar keys + a `viaFields` map — the inputs {@link mergeViaFields} reconciles. */
export interface ViaFieldSources {
  readonly moneyFields?: Record<string, ViaDescriptor> | undefined
  readonly i18nFields?: Record<string, I18nTextDescriptor> | undefined
  readonly dictKeyFields?: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined
  /** — lookup()/enumOf()/dict() sugar key (#650 Task 2). */
  readonly lookupFields?: Record<string, LookupDescriptor> | undefined
  readonly viaFields?: Record<string, ViaFieldSpec> | undefined
}

/** The effective per-feature field maps after merging sugar keys with `viaFields`. */
export interface MergedViaFields {
  readonly moneyFields: Record<string, ViaDescriptor> | undefined
  readonly i18nFields: Record<string, I18nTextDescriptor> | undefined
  readonly dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined
  /** `via(computed(fn, { deps, mode }))` entries (#638 Task 7) — there is no `computed`
   *  sugar KEY to merge against here (unlike money/i18n/dictKey); `collection-config.ts`
   *  unions this with the `computed:` option's own entries before splitting by mode. */
  readonly computedFields: Record<string, ComputedDescriptor> | undefined
  /** `lookupFields` sugar key merged with `via(lookup(...))`/`via(enumOf(...))`/`via(dict(...))`
   *  entries (#650 Task 2) — a SEPARATE binding from i18n; `dictKey()`/`staticDict()` stay
   *  routed onto `dictKeyFields`/the i18n binding (the alias, unchanged). */
  readonly lookupFields: Record<string, LookupDescriptor> | undefined
}

/**
 * Merge `viaFields` (the {@link via} composer) with the money/i18n sugar
 * keys into the effective maps every consumer reads — the kernel's
 * `compileViaBindings` (the `ViaPipeline` bindings) and `vault.ts`'s own
 * i18n/dict registries (put-time validation, dict-join/search resolution)
 * both call this so a field declared via `viaFields` behaves identically to
 * one declared under its feature's sugar key.
 *
 * Each `viaFields` entry's descriptors are grouped by `_viaBrand`; an
 * `'i18n'`-branded descriptor further splits by shape (i18nText vs
 * dictKey/staticDict) via the existing descriptor-shape predicates. A field
 * name declared in BOTH a sugar key and `viaFields` throws `ValidationError`
 * — one declaration site per field (#623 Task 9).
 */
export function mergeViaFields(sources: ViaFieldSources): MergedViaFields {
  // Sugar-vs-sugar collision (review fix): dictKeyFields and lookupFields
  // naming the same field is otherwise silently ambiguous — mirrors the
  // viaFields-vs-sugar check below (#623 Task 9), one declaration site per field.
  for (const field of Object.keys(sources.dictKeyFields ?? {})) {
    if (sources.lookupFields && field in sources.lookupFields) {
      throw new ValidationError(
        `mergeViaFields(): field "${field}" is declared in both \`dictKeyFields\` and \`lookupFields\` — declare it in one place only.`,
      )
    }
  }
  if (!sources.viaFields || Object.keys(sources.viaFields).length === 0) {
    return {
      moneyFields: sources.moneyFields, i18nFields: sources.i18nFields, dictKeyFields: sources.dictKeyFields,
      computedFields: undefined, lookupFields: sources.lookupFields,
    }
  }
  const sugarFieldNames = new Set([
    ...Object.keys(sources.moneyFields ?? {}),
    ...Object.keys(sources.i18nFields ?? {}),
    ...Object.keys(sources.dictKeyFields ?? {}),
    ...Object.keys(sources.lookupFields ?? {}),
  ])
  const viaMoney: Record<string, ViaDescriptor> = {}
  const viaI18nText: Record<string, I18nTextDescriptor> = {}
  const viaDictKey: Record<string, DictKeyDescriptor | StaticDictDescriptor> = {}
  const viaComputed: Record<string, ComputedDescriptor> = {}
  const viaLookup: Record<string, LookupDescriptor> = {}
  for (const [field, spec] of Object.entries(sources.viaFields)) {
    if (sugarFieldNames.has(field)) {
      throw new ValidationError(
        `via(): field "${field}" is declared via both a sugar key and \`viaFields\` — declare it in one place only.`,
      )
    }
    for (const descriptor of spec.descriptors) {
      if (descriptor._viaBrand === 'money') {
        viaMoney[field] = descriptor
      } else if (descriptor._viaBrand === 'i18n') {
        if (isI18nTextDescriptor(descriptor)) viaI18nText[field] = descriptor
        else if (isDictKeyDescriptor(descriptor) || isStaticDictDescriptor(descriptor)) viaDictKey[field] = descriptor
      } else if (descriptor._viaBrand === 'computed') {
        viaComputed[field] = descriptor as ComputedDescriptor
      } else if (descriptor._viaBrand === 'lookup' && isLookupDescriptor(descriptor)) {
        viaLookup[field] = descriptor
      } else {
        throw new ValidationError(`via(): field "${field}" has a descriptor with unrecognized _viaBrand "${descriptor._viaBrand}" — via() only supports money/i18n/computed/lookup descriptors today.`)
      }
    }
  }
  return {
    moneyFields: Object.keys(viaMoney).length > 0 ? { ...(sources.moneyFields ?? {}), ...viaMoney } : sources.moneyFields,
    i18nFields: Object.keys(viaI18nText).length > 0 ? { ...(sources.i18nFields ?? {}), ...viaI18nText } : sources.i18nFields,
    dictKeyFields: Object.keys(viaDictKey).length > 0 ? { ...(sources.dictKeyFields ?? {}), ...viaDictKey } : sources.dictKeyFields,
    computedFields: Object.keys(viaComputed).length > 0 ? viaComputed : undefined,
    lookupFields: Object.keys(viaLookup).length > 0 ? { ...(sources.lookupFields ?? {}), ...viaLookup } : sources.lookupFields,
  }
}

/** Maps each per-family field-map's option key to its binding family name — used by
 *  {@link guardCrossBindingFieldCollisions}/{@link guardReconcileCollisions} to tell a genuine
 *  cross-family collision apart from the SAME family surfaced through two sugar keys
 *  (`i18nFields` + `dictKeyFields` both feed the ONE 'i18n' binder — not this guard's job; a
 *  family's own duplicate handling stays wherever it already lives). Moved here from
 *  `collection-config.ts` (#664 Part 1) — that module now imports `guardCrossBindingFieldCollisions`
 *  back from here instead (a circular import the other way: `collection-config.ts` already
 *  imports FROM this module for `mergeViaFields`). Module-private — only the two guards above,
 *  both in this file, read it. */
const VIA_FIELD_MAP_FAMILY: Readonly<Record<string, string>> = {
  moneyFields: 'money', i18nFields: 'i18n', dictKeyFields: 'i18n', lookupFields: 'lookup',
  classifiedFields: 'classified', blobFields: 'blob', computed: 'computed',
}

/**
 * #631 — declare-time cross-binding same-field collision guard. Today the same field named
 * in two DIFFERENT via-binding families (e.g. the same field in both `moneyFields` and
 * `blobFields`) resolves silently by compile-order first-wins in `ViaPipeline`'s per-field
 * posture/clause lookup — undefined pipeline behavior for a config that is almost certainly a
 * mistake. `mergeViaFields` already guards sugar-vs-`viaFields` and `dictKeyFields`-vs-
 * `lookupFields` collisions (#623 Task 9); this runs one step later, in `compileViaBindings`
 * (fresh construction) or {@link guardReconcileCollisions} (late-attach reconcile), because
 * those are the only seams that also see `classifiedFields`/`blobFields` — neither is part of
 * `ViaFieldSources`, so `mergeViaFields` never sees them.
 *
 * WHY FAMILY-BASED, NOT PROVENANCE-BASED (#631 review, round 2 — Controller ruling): a field
 * declared via `via(computed(fn), money(...))` and a field declared via two independent sugar
 * maps (`computed: { total: fn }` + `moneyFields: { total: money(...) }`) are NOT
 * distinguishable here — `mergeViaFields` folds both declaration STYLES into the IDENTICAL
 * merged per-family field maps this function receives; provenance (which style produced a given
 * map entry) is erased before this guard ever runs. Narrowing the exemption to "only
 * via()-composed fields" would therefore require threading a second, parallel
 * provenance-tracking data structure through `mergeViaFields` for the sole purpose of refusing a
 * config that is BEHAVIORALLY IDENTICAL to the sanctioned one — refusing it would be a
 * behavior-lock violation (breaking a legal, meaningful config), not a bug fix. The exemption is
 * therefore keyed on the FAMILY SET alone, and instead earned empirically per family (below).
 *
 * EXEMPT (test-earned, not merely asserted): `computed` colliding with EXACTLY ONE of
 * `money`/`i18n`/`lookup` on the same field. `via()`'s descriptor loop only accepts
 * money/i18n/computed/lookup `_viaBrand`s (`mergeViaFields` throws on any other brand), so a
 * computed+classified or computed+blob same-field pairing can never arise from composition — it
 * can only come from mistakenly naming the same field in `computed`/`viaFields` AND
 * `classifiedFields`/`blobFields`, which this guard still refuses. For the three families that
 * CAN legitimately arise, each is pinned by an end-to-end runtime test proving the composition
 * does something real (not just "doesn't throw") — see `computed/virtual.test.ts`:
 *   - money: the "composed grammar" tests (materialized-mode money formatting the computed
 *     output; the ORIGINAL evidence this exemption started from — see the money DOES/does NOT
 *     format the computed output pair).
 *   - i18n (dictKey) / lookup (dict()): the "composed grammar — computed + i18n/lookup
 *     families (#631 collision-guard exemption pins)" block, BOTH declaration styles
 *     (`via(computed(...), dictKey(...)/dict(...))` and the two-independent-sugar-maps form),
 *     materialized mode — proven to dress `<field>Label` off the computed output identically
 *     either way (the provenance-erasure claim above, empirically confirmed). Virtual mode for
 *     both families hits the SAME present-ORDER limitation money's own virtual composed-grammar
 *     test already documents (i18n/lookup's `present()` runs BEFORE computed's — a virtual field
 *     is never stored, so there is nothing to dress yet); pinned as a known limitation, not
 *     grounds to drop the family from the exemption (materialized mode is what proves the family
 *     genuinely composes).
 *
 * 3-CLAIMANT TIGHTENING (#631 review, round 2): the exemption requires EXACTLY TWO claimant
 * source-keys, not just two families. A field named in `computed` + BOTH `i18nFields` AND
 * `dictKeyFields` collapses to the same two families (`{computed, i18n}` — `dictKeyFields`
 * shares the `i18n` family) but is a genuine THREE-claimant collision: two independent i18n
 * sugar keys both claiming the field is itself a mistake this guard exists to catch, and must
 * not slip through because the family SET happens to match the earned exemption's shape.
 */
export function guardCrossBindingFieldCollisions(
  fieldMaps: Readonly<Record<string, Record<string, unknown> | undefined>>,
  // Minor fix (opus task review on #664a) — caller-accurate error prefix: fresh construction
  // (`collection-config.ts`) keeps the old default; {@link guardReconcileCollisions} (the
  // late-attach reconcile path) passes its OWN name instead of this function silently claiming
  // to be `compileViaBindings()` on a call it never made.
  callerPrefix = 'compileViaBindings()',
): void {
  const claimantsByField = new Map<string, Set<string>>()
  for (const [sourceKey, map] of Object.entries(fieldMaps)) {
    for (const field of Object.keys(map ?? {})) {
      const claimants = claimantsByField.get(field) ?? new Set<string>()
      claimants.add(sourceKey)
      claimantsByField.set(field, claimants)
    }
  }
  for (const [field, sourceKeys] of claimantsByField) {
    const families = new Set([...sourceKeys].map((key) => VIA_FIELD_MAP_FAMILY[key]))
    if (families.size < 2) continue // same family via two sugar keys (e.g. i18n/dictKey) — not this guard's job
    // Exactly two CLAIMANTS (not just two families) — see "3-CLAIMANT TIGHTENING" above.
    if (sourceKeys.size === 2 && families.has('computed')) {
      const other = [...families].find((f) => f !== 'computed')
      if (other === 'money' || other === 'i18n' || other === 'lookup') continue // composed grammar, test-earned (#638/#631)
    }
    const keys = [...sourceKeys].sort().map((k) => `\`${k}\``)
    const joined = keys.length === 2 ? keys.join(' and ') : `${keys.slice(0, -1).join(', ')}, and ${keys[keys.length - 1]}`
    throw new ValidationError(
      `${callerPrefix}: field "${field}" is declared in both ${joined} — a field cannot be claimed by two ` +
      'different via-binding families. Declare it in one place only.',
    )
  }
}

/**
 * #664 Part 1 — the late-attach reconcile-path sibling of {@link guardCrossBindingFieldCollisions}.
 * `vault.ts`'s reconcile ladder (a second-or-later `vault.collection(name, {...})` call on an
 * ALREADY-open collection) never ran the fresh-construction guard above, so two probe recipes
 * slipped through (round-2 fable review, 2026-07-13):
 *
 *  - **(a) incoming×incoming** — the SAME reconcile call names a field in two different
 *    families (e.g. `moneyFields`+`blobFields` both claiming `"amount"`). Fix: re-run
 *    {@link guardCrossBindingFieldCollisions} verbatim over THIS call's own merged field maps —
 *    identical semantics to fresh construction, just invoked one call later.
 *  - **(b) existing×incoming** — an EARLIER call already compiled a binding covering a field
 *    (money reconciled onto it, or it shipped with the collection's first declaration), and
 *    THIS call's incoming family map claims the SAME field for a DIFFERENT family (e.g. call-1
 *    `classifiedFields:['ssn']`, call-2 `moneyFields:{ssn}`) — undetectable by (a) alone since
 *    the collision spans two calls. Read via the LIVE collection's compiled bindings
 *    (`coll._via.bindings`): each `ViaBinding.covers(field)` (`via.ts`) plus its `brand` tells us
 *    which family already owns the field, mapped through the SAME {@link VIA_FIELD_MAP_FAMILY}
 *    the incoming side uses — no new collection.ts surface needed.
 *
 * Both sub-checks honor the SAME #631 exemption (`{computed,money}`/`{computed,i18n}`/
 * `{computed,lookup}`, exactly-two-claimants) as the fresh guard — a composition that would be
 * legal in one `vault.collection()` call (`via(computed(fn), money(...))`) must stay legal when
 * split across two calls (computed declared fresh, money late-attached), since the two paths are
 * behaviorally equivalent by the same provenance-erasure argument {@link guardCrossBindingFieldCollisions}
 * documents. `existingFamilies` is collected as a SET (every binding covering the field, not just
 * the first match) so an already-legally-composed pair (e.g. existing `{computed, money}`) is
 * checked against the incoming family individually — a THIRD family colliding with either half
 * is still refused.
 */
export function guardReconcileCollisions(
  existingVia: ViaPipeline | undefined,
  incomingFieldMaps: Readonly<Record<string, Record<string, unknown> | undefined>>,
): void {
  guardCrossBindingFieldCollisions(incomingFieldMaps, 'guardReconcileCollisions()') // (a) incoming×incoming
  if (!existingVia) return
  // `taint` is a posture OVERLAY, not a field-owning family — under `sealAll` its `covers()` is
  // true for every non-`_` field, so it must never be mapped through VIA_FIELD_MAP_FAMILY here
  // (same exclusion precedent as via-graph-wiring.ts's `.filter(b => b.brand !== 'taint')`).
  const existingBindings: readonly ViaBinding[] = existingVia.bindings.filter((b) => b.brand !== 'taint')
  for (const [sourceKey, map] of Object.entries(incomingFieldMaps)) {
    const incomingFamily = VIA_FIELD_MAP_FAMILY[sourceKey]
    if (incomingFamily === undefined) continue
    for (const field of Object.keys(map ?? {})) {
      const existingFamilies = new Set(
        existingBindings.filter((b) => b.covers?.(field)).map((b) => b.brand),
      )
      for (const existingFamily of existingFamilies) {
        if (existingFamily === incomingFamily) continue // same family — first-wins on the _apply* side handles it
        const isExempt = (existingFamily === 'computed' && (incomingFamily === 'money' || incomingFamily === 'i18n' || incomingFamily === 'lookup'))
          || (incomingFamily === 'computed' && (existingFamily === 'money' || existingFamily === 'i18n' || existingFamily === 'lookup'))
        if (isExempt) continue // composed grammar, test-earned (#638/#631) — legal fresh, stays legal late
        throw new ValidationError(
          `vault.collection(): field "${field}" is already bound by the "${existingFamily}" via family on this ` +
          `collection — an incoming \`${sourceKey}\` declaration cannot claim it for a different family ` +
          `("${incomingFamily}"). Declare it in one place only.`,
        )
      }
    }
  }
}
