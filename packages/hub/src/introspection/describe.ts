/**
 * `buildDescription` — pure assembler that merges collection config
 * (moneyFields / dictKeyFields / refs / computed / fieldMeta) with an
 * optional validator-derived `zodFields` map into a normalised
 * {@link CollectionDescription}.
 *
 * The sync path (`collection.describe()`) passes `zodFields: undefined`.
 * The async path (Task 4 — #483) supplies a populated map and validator-
 * derived type strings.
 *
 * @module
 */

import type { FieldMeta } from './field-meta.js'
import { resolveFieldMeta } from './field-meta.js'
import type { MoneyDescriptor } from '../money/descriptor.js'
import type { DictKeyDescriptor, StaticDictDescriptor } from '../i18n/dictionary.js'
import { isStaticDictDescriptor } from '../i18n/dictionary.js'
import type { ComputedFields } from '../computed/index.js'
import type { RefDescriptor } from '../refs.js'

// ─── Public types ──────────────────────────────────────────────────────────

export interface DescribedField {
  readonly key: string
  /** Sync: inferred from config ('number'|'enum'|'string'|'array'|'unknown'). Async (Task 4): validator-derived. */
  readonly type: string
  readonly optional: boolean
  readonly constraints?: Record<string, unknown>
  readonly label: string
  readonly description?: string
  readonly semanticType?: string
  readonly unit?: string
  readonly sensitivity?: 'public' | 'pii' | 'secret'
  readonly aggregate?: 'sum' | 'count' | 'distinct' | 'none'
  readonly aliases?: readonly string[]
  readonly ref?: { target: string; mode: string; isArray?: true }
  readonly displayFor?: string
  readonly money?: { mode: 'fixed' | 'multi'; currency?: string; scale?: number; rounding?: string }
  readonly dict?: { name: string; static: boolean; values?: readonly { value: string; label?: string }[] }
  readonly computed?: true
}

export interface CollectionDescription {
  readonly collection: string
  readonly fields: readonly DescribedField[]
}

/** Options for the async describe() overload (Task 4 supplies the content). */
export interface DescribeOptions {
  /** Reserved for Task 4 — async validator-derived type resolution. */
  readonly _async?: true
}

// ─── ZodField slot (async path wires this; sync path passes undefined) ───

export interface ZodFieldSlot {
  readonly type?: string
  readonly optional?: boolean
  readonly meta?: Partial<FieldMeta>
}

// ─── buildDescription ─────────────────────────────────────────────────────

export interface BuildDescriptionInput {
  readonly collection: string
  readonly fieldMeta: Record<string, FieldMeta> | undefined
  readonly moneyFields: Record<string, MoneyDescriptor> | undefined
  readonly dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined
  readonly computed: ComputedFields | undefined
  readonly refs: Record<string, RefDescriptor>
  /** Async path fills this; sync path passes `undefined`. */
  readonly zodFields: Record<string, ZodFieldSlot> | undefined
}

/**
 * Pure assembler: no I/O, no side effects.
 * Builds a {@link CollectionDescription} from the collection's in-memory config.
 */
export function buildDescription(input: BuildDescriptionInput): CollectionDescription {
  const { collection, fieldMeta, moneyFields, dictKeyFields, computed, refs, zodFields } = input

  // Union of all config key sources — stable alphabetical order.
  const allKeys = new Set<string>([
    ...Object.keys(moneyFields ?? {}),
    ...Object.keys(dictKeyFields ?? {}),
    ...Object.keys(refs),
    ...Object.keys(computed ?? {}),
    ...Object.keys(fieldMeta ?? {}),
    ...Object.keys(zodFields ?? {}),
  ])

  const fields: DescribedField[] = []

  for (const key of [...allKeys].sort()) {
    const zod = zodFields?.[key]
    const money = moneyFields?.[key]
    const dict = dictKeyFields?.[key]
    const refDesc = refs[key]
    const isComputed = computed !== undefined && key in computed

    // ── Infer type + structural extras ────────────────────────────────────
    let type = zod?.type ?? 'unknown'
    const inferred: Partial<FieldMeta> = {}

    let moneyBlock: DescribedField['money'] | undefined
    let dictBlock: DescribedField['dict'] | undefined
    let refBlock: DescribedField['ref'] | undefined

    if (money) {
      type = 'number'
      inferred.semanticType = 'currency'
      inferred.aggregate = 'sum'
      const currency = money.soleCurrency()
      const scale = currency !== undefined ? money.scaleFor(currency) : undefined
      moneyBlock = {
        mode: money.mode,
        ...(currency !== undefined ? { currency } : {}),
        ...(scale !== undefined ? { scale } : {}),
        ...(money.rounding !== undefined ? { rounding: money.rounding } : {}),
      }
    } else if (refDesc) {
      type = refDesc.isArray ? 'array' : 'string'
      inferred.semanticType = 'entity'
      refBlock = {
        target: refDesc.target,
        mode: refDesc.mode,
        ...(refDesc.isArray ? { isArray: true as const } : {}),
      }
    } else if (dict) {
      type = 'enum'
      if (isStaticDictDescriptor(dict)) {
        // Static dict: labels available synchronously from the in-code table.
        const displayLocale = dict.displayLocale
        const values = dict.keys.map((k) => {
          const localeMap = dict.table[k]
          const label = displayLocale !== undefined
            ? (localeMap?.[displayLocale] ?? undefined)
            : undefined
          return label !== undefined
            ? { value: k, label }
            : { value: k }
        })
        dictBlock = { name: dict.name, static: true, values }
      } else {
        // Dynamic dictKey: keys declared but labels are async (Task 4).
        const values = dict.keys !== undefined
          ? dict.keys.map((k) => ({ value: k }))
          : undefined
        dictBlock = {
          name: dict.name,
          static: false,
          ...(values !== undefined ? { values } : {}),
        }
      }
    } else if (isComputed) {
      type = zod?.type ?? 'unknown'
    }

    // ── Merge fieldMeta channel ────────────────────────────────────────────
    const channelEntry = fieldMeta?.[key]
    const zodMeta = zod?.meta
    const resolved = resolveFieldMeta(key, {
      ...(channelEntry !== undefined ? { channel: channelEntry } : {}),
      ...(zodMeta !== undefined ? { zodMeta } : {}),
      inferred,
    })

    // ── Assemble the field (exactOptionalPropertyTypes-safe spreads) ───────
    const field: DescribedField = {
      key,
      type,
      optional: zod?.optional ?? false,
      label: resolved.label,
      ...(resolved.description !== undefined ? { description: resolved.description } : {}),
      ...(resolved.semanticType !== undefined ? { semanticType: resolved.semanticType } : {}),
      ...(resolved.unit !== undefined ? { unit: resolved.unit } : {}),
      ...(resolved.sensitivity !== undefined ? { sensitivity: resolved.sensitivity } : {}),
      ...(resolved.aggregate !== undefined ? { aggregate: resolved.aggregate } : {}),
      ...(resolved.aliases !== undefined ? { aliases: resolved.aliases } : {}),
      ...(resolved.displayFor !== undefined ? { displayFor: resolved.displayFor } : {}),
      ...(refBlock !== undefined ? { ref: refBlock } : {}),
      ...(moneyBlock !== undefined ? { money: moneyBlock } : {}),
      ...(dictBlock !== undefined ? { dict: dictBlock } : {}),
      ...(isComputed ? { computed: true as const } : {}),
    }

    fields.push(field)
  }

  return { collection, fields }
}
