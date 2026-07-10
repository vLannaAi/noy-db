/**
 * `buildDescription` — pure assembler that merges collection config
 * (moneyFields / dictKeyFields / refs / computed / fieldMeta) with an
 * optional validator-derived `zodFields` map into a normalised
 * {@link CollectionDescription}.
 *
 * The sync path (`collection.describe()`) passes `zodFields: undefined`.
 * The async path supplies a populated map and validator-derived type
 * strings.
 *
 * @module
 */

import type { FieldMeta } from './field-meta.js'
import { resolveFieldMeta, validateFieldMetaKeys, FieldMetaUnknownFieldError, humanizeFieldKey } from './field-meta.js'
import type { CollectionMeta } from './meta.js'
import type { MoneyDescriptor } from '../../shape/via-money/descriptor.js'
import type { ViaDescriptor } from '../../kernel/via.js'
import type { DictKeyDescriptor, StaticDictDescriptor } from '../i18n/dictionary.js'
import { isStaticDictDescriptor } from '../i18n/dictionary.js'
import type { I18nTextDescriptor } from '../i18n/core.js'
import type { ComputedFields } from '../../with-formula/computed/index.js'
import type { RefDescriptor } from '../../kernel/refs.js'
import type { ClassifiedFieldSpec } from '../classified/descriptor.js'
import { derivePersistedSchema, isZod4Schema } from '../persisted-schemas/derive.js'
import { jsonSchemaToFields } from './fields.js'

// ─── Public types ──────────────────────────────────────────────────────────

export interface DescribedField {
  readonly key: string
  /** Sync: inferred from config ('number'|'enum'|'string'|'array'|'unknown'). Async (Task 4): validator-derived. */
  readonly type: string
  readonly optional: boolean
  readonly constraints?: Record<string, unknown>
  readonly label: string
  readonly description?: string
  /** Card/section grouping hint for detail & form layouts. From fieldMeta/zod .meta(). */
  readonly group?: string
  /** Relative ordering hint within and across groups. Lower renders first. */
  readonly order?: number
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
  /** i18n metadata for fields declared with i18nText(). Present only when the field is i18n-enabled. */
  readonly i18n?: { readonly locales?: readonly string[]; readonly densify?: boolean }
  /** Widget hint derived from semanticType+type, overridable via fieldMeta.widget. */
  readonly widget: string
  /** Whether the field is user-editable. False for computed, id, and provenance-stamped fields. */
  readonly editable: boolean
  /** Present when the field is classified. Serialized read-projection contract. */
  readonly classified?: {
    readonly preset: string
    readonly storage: 'recoverable' | 'never' | 'digest-only'
    readonly list: 'omit' | { readonly mask: string } | { readonly rider: string }
    /**
     * Present (and `true`) only when the field opted into the equatable blind
     * index. Additive metadata — emitted UNGATED (no `withClassified()` needed;
     * `toJSONSchema()` carries it too), so it advertises *that* the field is
     * equatable beyond the DEK-consent boundary. Intended: it's a structural
     * property a schema consumer legitimately needs and discloses no value. A
     * deployment wanting it gated can gate this behind its value-bearing door.
     */
    readonly equatable?: true
  }
}

export interface CollectionDescription {
  readonly collection: string
  readonly fields: readonly DescribedField[]
  /** Collection-level descriptive metadata; label falls back to the humanized collection name. */
  readonly meta: CollectionMeta
}

/** Options for the async describe(opts) overload. */
export interface DescribeOptions {
  /**
   * When true, resolve dynamic-dict labels from vault.dictionary(name).list()
   * and populate dict.values[].label for dynamic dictKey fields.
   */
  readonly resolveDictLabels?: boolean
}

// ─── ZodField slot (async path wires this; sync path passes undefined) ───

export interface ZodFieldSlot {
  readonly type?: string
  readonly optional?: boolean
  readonly constraints?: Record<string, unknown>
  readonly meta?: Partial<FieldMeta>
}

// ─── RECOGNIZED zod-4 .meta() keys ────────────────────────────────────────
//
// Empirically verified 2026-06-25 via:
//   node -e "const {z,toJSONSchema}=require('zod'); console.log(JSON.stringify(toJSONSchema(z.object({n:z.number().meta({label:'L',unit:'kg',sensitivity:'public',semanticType:'percent',description:'d',aggregate:'sum',aliases:['a'],displayFor:'x'})}))), null, 2)"
// Result: .meta() keys are emitted INLINE on each JSON Schema property object
//   at the same level as `type`/`format` — NOT nested under a `metadata` key.
// Example: z.number().meta({ unit: 'kg' }) → { "type": "number", "unit": "kg" }
// Unknown .meta() keys (not in this set) are ignored.
const ZOD_META_KEYS = new Set<string>([
  'label', 'description', 'unit', 'semanticType', 'sensitivity', 'aggregate', 'aliases', 'displayFor',
  'group', 'order',
])

// ─── deriveZodFields ──────────────────────────────────────────────────────

/**
 * Derive per-field slots from a Standard Schema validator.
 * - Calls `derivePersistedSchema` to get the JSON Schema.
 * - Falls back to `{}` for non-Zod or unknown validators.
 * - For zod-4 schemas: reads recognized `.meta()` keys from inline property annotations.
 * - Returns: `Record<fieldKey, { type, optional, constraints?, meta? }>`.
 *
 * No static zod import — all zod access is lazy via derivePersistedSchema.
 */
export async function deriveZodFields(
  schema: unknown,
): Promise<Record<string, ZodFieldSlot>> {
  const envelope = await derivePersistedSchema(schema)
  if (!envelope.jsonSchema) return {}

  const isZod4 = isZod4Schema(schema)
  const jsonSchema = envelope.jsonSchema as Record<string, unknown>

  // Use the existing JSON-Schema→field mapper for type/optional/constraints.
  const fieldDescriptors = jsonSchemaToFields(jsonSchema, 'live-validator')

  // For zod-4: the JSON Schema properties contain inline .meta() annotations.
  // We need to walk the raw properties to extract recognized meta keys.
  const propertiesRaw = jsonSchema['properties'] as Record<string, Record<string, unknown>> | undefined

  const result: Record<string, ZodFieldSlot> = {}

  for (const [key, descriptor] of Object.entries(fieldDescriptors)) {
    let meta: Partial<FieldMeta> | undefined

    if (isZod4 && propertiesRaw) {
      const prop = propertiesRaw[key]
      if (prop) {
        const extracted: Partial<FieldMeta> = {}
        let hasAny = false
        for (const mk of ZOD_META_KEYS) {
          if (mk in prop) {
            (extracted as Record<string, unknown>)[mk] = prop[mk]
            hasAny = true
          }
        }
        if (hasAny) meta = extracted
      }
    }

    result[key] = {
      type: descriptor.type,
      optional: descriptor.optional === true,
      ...(descriptor.constraints !== undefined ? { constraints: descriptor.constraints } : {}),
      ...(meta !== undefined ? { meta } : {}),
    }
  }

  return result
}

// ─── buildDescription ─────────────────────────────────────────────────────

export interface BuildDescriptionInput {
  readonly collection: string
  readonly fieldMeta: Record<string, FieldMeta> | undefined
  /**
   * Kernel-visible collections only carry the opaque {@link ViaDescriptor}
   * marker (the kernel never inspects a Via feature's concrete descriptor
   * shape). Every entry here is actually a {@link MoneyDescriptor} — only
   * `money()` constructs them — narrowed locally below where its
   * mode/currency/scale are read for the describe() output.
   */
  readonly moneyFields: Record<string, ViaDescriptor> | undefined
  readonly dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor> | undefined
  readonly computed: ComputedFields | undefined
  readonly refs: Record<string, RefDescriptor>
  /** Async path fills this; sync path passes `undefined`. */
  readonly zodFields: Record<string, ZodFieldSlot> | undefined
  /**
   * Async path: when `resolveDictLabels` was true, this map holds
   * `{ dictName -> { value -> label } }` for dynamic dictKey fields.
   * Used to populate `dict.values[].label`.
   */
  readonly dictLabels?: Record<string, Record<string, string>> | undefined
  /** Collection-level descriptive metadata. Label falls back to humanized collection name. */
  readonly meta?: CollectionMeta | undefined
  /**
   * Map of field name → I18nTextDescriptor for fields declared with i18nText().
   * When present, describe() surfaces an `i18n` block on matching DescribedField entries.
   */
  readonly i18nFields?: Record<string, I18nTextDescriptor> | undefined
  /** Per-field classified specs (already resolved/flattened). */
  readonly classified?: Record<string, ClassifiedFieldSpec> | undefined
}

// Re-export so that callers that want to catch the error don't need another import path.
export { FieldMetaUnknownFieldError }

// ─── Widget derivation ────────────────────────────────────────────────────────

/**
 * Derive a widget hint from resolved field metadata.
 * Priority: explicit override (resolvedWidget) > semanticType > dict > type > 'text'.
 */
function deriveWidget(opts: {
  semanticType?: string
  type: string
  dict?: unknown
  resolvedWidget?: string
}): string {
  if (opts.resolvedWidget !== undefined) return opts.resolvedWidget
  switch (opts.semanticType) {
    case 'date':
    case 'datetime':
      return 'date'
    case 'currency':
      return 'money'
    case 'entity':
      return 'ref-select'
    case 'url':
      return 'url'
    case 'email':
      return 'email'
    case 'percent':
      return 'number'
  }
  if (opts.dict !== undefined) return 'select'
  if (opts.type === 'boolean') return 'checkbox'
  if (opts.type === 'number') return 'number'
  return 'text'
}

/**
 * Pure assembler: no I/O, no side effects.
 * Builds a {@link CollectionDescription} from the collection's in-memory config.
 *
 * When `zodFields` is supplied (async path), validates that every `fieldMeta` key
 * refers to a known field (config ∪ zodFields). Throws `FieldMetaUnknownFieldError`
 * on the first unknown key — this is the real validation that the vault.ts no-op
 * couldn't do (schema fields weren't knowable synchronously).
 */
export function buildDescription(input: BuildDescriptionInput): CollectionDescription {
  const { collection, fieldMeta, moneyFields, dictKeyFields, computed, refs, zodFields, dictLabels, meta, i18nFields, classified } = input

  // When zodFields is present AND non-empty (async path, validator successfully derived
  // a schema): validate fieldMeta keys against the real known-field set = config keys ∪
  // zodFields keys. This is the carry from Task 1: vault.ts couldn't do this synchronously
  // (schema fields weren't knowable at config time without running async derivation).
  //
  // When zodFields is empty (non-zod / unknown validator returned no schema info),
  // we cannot validate — skip to remain validator-agnostic.
  if (zodFields !== undefined && Object.keys(zodFields).length > 0 && fieldMeta !== undefined) {
    const knownFields = new Set<string>([
      ...Object.keys(moneyFields ?? {}),
      ...Object.keys(dictKeyFields ?? {}),
      ...Object.keys(refs),
      ...Object.keys(computed ?? {}),
      ...Object.keys(zodFields),
      ...Object.keys(i18nFields ?? {}),
    ])
    validateFieldMetaKeys(collection, fieldMeta, knownFields)
  }

  // Union of all config key sources — stable alphabetical order.
  const allKeys = new Set<string>([
    ...Object.keys(moneyFields ?? {}),
    ...Object.keys(dictKeyFields ?? {}),
    ...Object.keys(refs),
    ...Object.keys(computed ?? {}),
    ...Object.keys(fieldMeta ?? {}),
    ...Object.keys(zodFields ?? {}),
    ...Object.keys(i18nFields ?? {}),
    ...Object.keys(classified ?? {}),
  ])

  const fields: DescribedField[] = []

  for (const key of [...allKeys].sort()) {
    const zod = zodFields?.[key]
    // Narrow the opaque marker back to the concrete descriptor — see the
    // {@link BuildDescriptionInput.moneyFields} doc comment.
    const money = moneyFields?.[key] as MoneyDescriptor | undefined
    const dict = dictKeyFields?.[key]
    const refDesc = refs[key]
    const isComputed = computed !== undefined && key in computed
    const i18nDesc = i18nFields?.[key]
    const cls = classified?.[key]

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
        // Dynamic dictKey: keys declared in config; labels optionally resolved
        // from vault.dictionary(name).list() when resolveDictLabels was requested.
        const labelMap = dictLabels?.[dict.name]
        const labelMapHasEntries = labelMap !== undefined && Object.keys(labelMap).length > 0
        if (labelMapHasEntries) {
          // We have resolved labels — build values from the label map.
          const values = Object.entries(labelMap).map(([value, label]) => ({ value, label }))
          dictBlock = { name: dict.name, static: false, values }
        } else if (dict.keys !== undefined) {
          const values = dict.keys.map((k) => {
            const label = dict.labels?.[k]
            return label !== undefined ? { value: k, label } : { value: k }
          })
          dictBlock = { name: dict.name, static: false, values }
        } else {
          dictBlock = { name: dict.name, static: false }
        }
      }
    } else if (i18nDesc) {
      // i18nText field: the stored value is a locale-map object, but the resolved
      // type exposed to consumers is 'string' (locale resolution collapses to a string).
      type = 'string'
    } else if (isComputed) {
      // type already initialized to zod?.type ?? 'unknown' above; no re-set needed
    }

    // Classified sensitivity feeds inferred meta at lowest precedence — channel
    // fieldMeta and zod .meta() still win via resolveFieldMeta's merge order.
    if (cls !== undefined) inferred.sensitivity = cls.sensitivity

    // ── Merge fieldMeta channel ────────────────────────────────────────────
    const channelEntry = fieldMeta?.[key]
    const zodMeta = zod?.meta
    const resolved = resolveFieldMeta(key, {
      ...(channelEntry !== undefined ? { channel: channelEntry } : {}),
      ...(zodMeta !== undefined ? { zodMeta } : {}),
      inferred,
    })

    // ── i18n block (only for i18nText fields) ─────────────────────────────
    let i18nBlock: DescribedField['i18n'] | undefined
    if (i18nDesc !== undefined) {
      const locales = i18nDesc.options.languages
      const densify = i18nDesc.options.densifyOnWrite
      i18nBlock = {
        ...(locales !== undefined ? { locales } : {}),
        ...(densify !== undefined ? { densify } : {}),
      }
    }

    // ── Widget (derived, overridable via resolvedWidget from fieldMeta/zodMeta) ──
    const widget = deriveWidget({
      type,
      ...(resolved.semanticType !== undefined ? { semanticType: resolved.semanticType } : {}),
      ...(dictBlock !== undefined ? { dict: dictBlock } : {}),
      ...(resolved.widget !== undefined ? { resolvedWidget: resolved.widget } : {}),
    })

    // ── Editable: false for computed, id, provenance-stamped fields ────────
    // Provenance fields (_source, _sourceTs) are envelope-level metadata, not
    // user schema fields — they won't appear as keys in fieldMeta so this check
    // is implicitly handled (they'd never appear in allKeys). Explicitly guard
    // computed + 'id' as the two structural non-editable cases.
    const editable = !isComputed && key !== 'id'

    // ── Assemble the field (exactOptionalPropertyTypes-safe spreads) ───────
    const field: DescribedField = {
      key,
      type,
      optional: zod?.optional ?? false,
      ...(zod?.constraints !== undefined ? { constraints: zod.constraints } : {}),
      label: resolved.label,
      ...(resolved.description !== undefined ? { description: resolved.description } : {}),
      ...(resolved.group !== undefined ? { group: resolved.group } : {}),
      ...(resolved.order !== undefined ? { order: resolved.order } : {}),
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
      ...(i18nBlock !== undefined ? { i18n: i18nBlock } : {}),
      widget,
      editable,
      ...(cls !== undefined ? {
        classified: {
          preset: cls.preset,
          storage: cls.storage,
          list: cls.list.kind === 'omit' ? 'omit' as const
            : cls.list.kind === 'mask' ? { mask: cls.list.pattern }
            : { rider: cls.list.rider },
          ...(cls.equatable === true ? { equatable: true as const } : {}),
        },
      } : {}),
    }

    fields.push(field)
  }

  // Build collection-level meta with label fallback to humanized collection name.
  const collectionMeta: CollectionMeta = {
    ...meta,
    label: meta?.label ?? humanizeFieldKey(collection),
  }

  return {
    collection,
    fields,
    meta: collectionMeta,
  }
}
