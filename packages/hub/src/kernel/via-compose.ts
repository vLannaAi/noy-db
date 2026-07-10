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
import type { ViaDescriptor } from './via.js'
// Types + shape-classification predicates reach through the kernel's own
// `port/with/` hook seam (never `src/shape/` directly) — #623 Task 11.
// `isI18nTextDescriptor`/`isDictKeyDescriptor` are pure tag checks moved
// onto the port alongside `isStaticDictDescriptor` (see i18n-strategy.ts);
// the descriptor types were already port-owned re-exports (#623 Task 8).
import type { DictKeyDescriptor, I18nTextDescriptor, StaticDictDescriptor } from '../port/with/i18n-strategy.js'
import { isDictKeyDescriptor, isI18nTextDescriptor, isStaticDictDescriptor } from '../port/with/i18n-strategy.js'

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

/** The money/i18n sugar keys + a `viaFields` map — the inputs {@link mergeViaFields} reconciles. */
export interface ViaFieldSources {
  readonly moneyFields?: Record<string, ViaDescriptor> | undefined
  readonly i18nFields?: Record<string, I18nTextDescriptor> | undefined
  readonly dictKeyFields?: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined
  readonly viaFields?: Record<string, ViaFieldSpec> | undefined
}

/** The effective per-feature field maps after merging sugar keys with `viaFields`. */
export interface MergedViaFields {
  readonly moneyFields: Record<string, ViaDescriptor> | undefined
  readonly i18nFields: Record<string, I18nTextDescriptor> | undefined
  readonly dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined
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
  if (!sources.viaFields || Object.keys(sources.viaFields).length === 0) {
    return { moneyFields: sources.moneyFields, i18nFields: sources.i18nFields, dictKeyFields: sources.dictKeyFields }
  }
  const sugarFieldNames = new Set([
    ...Object.keys(sources.moneyFields ?? {}),
    ...Object.keys(sources.i18nFields ?? {}),
    ...Object.keys(sources.dictKeyFields ?? {}),
  ])
  const viaMoney: Record<string, ViaDescriptor> = {}
  const viaI18nText: Record<string, I18nTextDescriptor> = {}
  const viaDictKey: Record<string, DictKeyDescriptor | StaticDictDescriptor> = {}
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
      } else {
        throw new ValidationError(`via(): field "${field}" has a descriptor with unrecognized _viaBrand "${descriptor._viaBrand}" — via() only supports money/i18n descriptors today.`)
      }
    }
  }
  return {
    moneyFields: Object.keys(viaMoney).length > 0 ? { ...(sources.moneyFields ?? {}), ...viaMoney } : sources.moneyFields,
    i18nFields: Object.keys(viaI18nText).length > 0 ? { ...(sources.i18nFields ?? {}), ...viaI18nText } : sources.i18nFields,
    dictKeyFields: Object.keys(viaDictKey).length > 0 ? { ...(sources.dictKeyFields ?? {}), ...viaDictKey } : sources.dictKeyFields,
  }
}
