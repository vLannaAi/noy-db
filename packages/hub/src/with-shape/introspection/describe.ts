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
import type { MoneyDescriptor } from '../../via/money/descriptor.js'
import type { ViaDescriptor, ViaPosture } from '../../kernel/via/index.js'
import type { DictKeyDescriptor, StaticDictDescriptor } from '../../via/i18n/dictionary.js'
import { isStaticDictDescriptor } from '../../via/i18n/dictionary.js'
// #650 Task 2 — native lookup()/enumOf()/dict() fields (separate from
// dictKeyFields above, which stays the dictKey()/staticDict() alias's own
// input). Emits the SAME `dict` block shape for byte-parity (the tiers this
// covers — 'static' with a table, 'reserved' — are the alias-equivalent
// ones; a first-class 'collection' backing degrades to the "no resolved
// labels" fallback, same as an unresolved dynamic dictKey).
import type { LookupDescriptor } from '../../via/lookup/descriptor.js'
// #650 Task 7 — the 'lookup' binding's describeFragment payload shape (the
// first-ever NoydbVia.describeFragment consumer, via/index.ts:136). describe.ts
// is NOT under kernel/**, so importing this via/ type directly is fine
// (Check 14 via-layering only restricts the kernel spine).
import type { LookupDescribeFragment, LookupDescribeFragmentEntry } from '../../via/lookup/binding.js'
// #657 — the 'blob' binding's describeFragment payload shape (the second-ever
// NoydbVia.describeFragment consumer, after lookup above). Same rationale:
// describe.ts is not under kernel/**, so importing this via/ type is fine.
import type { BlobDescribeFragment, BlobDescribeFragmentEntry } from '../../via/blob/binding.js'
import type { I18nTextDescriptor } from '../../via/i18n/core.js'
import type { ComputedFields } from '../../with-formula/computed/index.js'
import type { RefDescriptor } from '../../kernel/refs.js'
import type { ClassifiedFieldSpec } from '../../via/classified/descriptor.js'
import { derivePersistedSchema, isZod4Schema } from '../persisted-schemas/derive.js'
import { loadPersistedSchema } from '../persisted-schemas/storage.js'
import { jsonSchemaToFields } from './fields.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'

// ─── Public types ──────────────────────────────────────────────────────────

export interface DescribedField {
  readonly key: string
  /**
   * Stable, opaque per-field identity (#946) — survives a rename (the field
   * keeps its id when its name/`key` changes). Sourced from the persisted
   * schema's `PersistedSchemaEnvelope.fieldIds` map, so it is only present on
   * the async `describeAsync()` path for a collection that has persisted a
   * schema (`persistJsonSchema: true`) at least once; absent on the sync
   * `describe()` path (no store I/O) and on any field with no persisted id
   * yet.
   */
  readonly id?: string
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
  /**
   * Normalized lookup metadata (#650 Task 7 — the first-ever
   * `NoydbVia.describeFragment` consumer; sourced from the `'lookup'`
   * binding's fragment, NOT from config directly — see `buildDescription`).
   * Present for every `lookup()`/`enumOf()`/`dict()` field, ALONGSIDE the
   * pre-existing `dict` block above (kept byte-stable for the
   * `dictKey()`/`staticDict()` alias — this is additive, not a replacement).
   * `dimension` is omitted for a bare `enumOf()` (no backing store, no
   * dimension name — the #650 Task 2 `dimension:''` sentinel resolved).
   * `keys` is the statically-known closed-vocabulary key set (declared
   * `keys`, or a static table's own keys) — omitted when membership lives
   * only in the backing collection/dictionary.
   */
  readonly lookup?: {
    readonly dimension?: string
    readonly backing: 'static' | 'reserved' | 'collection'
    readonly vocabulary: 'open' | 'closed'
    readonly key: string
    readonly altKeys?: readonly string[]
    readonly present?: { readonly label: string; readonly by?: string }
    readonly sortBy?: string
    readonly onDelete: 'restrict' | 'cascade' | 'nullify'
    readonly keys?: readonly string[]
  }
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
  /**
   * Present only for a field declared via `blobFields` (#657) — out-of-band
   * attachment storage (`collection.blob(id)`), never a sealed or plaintext
   * record field. `queryable` mirrors the binding's fixed `ViaPosture`
   * (blob content is never indexed — always `'none'`); the rest mirrors the
   * declared `blobFields[field]` policy verbatim (scalars) or as a presence
   * flag (predicate knobs — a predicate has no serializable form). Sourced
   * from the `'blob'` binding's `describeFragment()`, the same
   * `viaFragments` door the `lookup` block above is sourced from.
   */
  readonly blob?: {
    readonly retainDays?: number
    readonly evictWhen?: true
    readonly legalHold?: true
    readonly retainUntil?: true
    readonly external?: true
    readonly public?: true
    readonly backlink?: string
    readonly queryable: 'none'
  }
  /**
   * Present only for a graph-tainted derived field (#638 Task 3 — computed/
   * derivation output whose effective posture was forced away from the
   * plain baseline by a source's posture, e.g. a computed field reading a
   * classified field). `forcedBy` names the immediate declared source
   * field(s) responsible.
   */
  readonly taint?: {
    readonly posture: ViaPosture
    readonly forcedBy: readonly string[]
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
/**
 * Field KEYS from a configured validator, synchronously — the complement to
 * {@link deriveZodFields}, which derives field TYPES and must be async.
 *
 * The distinction is the whole point (#1253). `describe()`'s sync path passed
 * `zodFields: undefined`, so `fieldMeta` key-validation could never run there
 * and a typo'd key became a PHANTOM FIELD carrying its declared `sensitivity`
 * while the real field went undescribed — an inventory wrong in both
 * directions, silently, on the surface `sensitivity` exists to serve.
 *
 * That was read as unavoidable ("the sync path cannot know the schema's
 * fields"), which is true of types and false of keys: a Zod object exposes
 * `.shape` directly, on both v3 and v4, with no JSON-Schema derivation and no
 * `zod-to-json-schema` peer. The latter matters — on Zod 3 that peer is
 * required for the async path, so the sync path is the only one some
 * consumers can reach.
 *
 * A duck-typed probe, not a Zod dependency: an unrecognised validator returns
 * `undefined` and the caller stays silent rather than guessing, so a validator
 * hub cannot read never produces a false "unknown field" error.
 *
 * ZodEffects (reported by the pilot on #1249's guard, and it equally affected
 * #1253's): on Zod 3 an OBJECT-LEVEL `.refine()` wraps the object in a
 * ZodEffects whose `.shape` is undefined — the object sits at `_def.schema` —
 * so "has a schema" and "hub can enumerate its fields" silently diverged for
 * exactly the schemas most worth guarding (validated ones). Unwrapped here,
 * but ONLY through refinement effects: a `.transform()`/`.preprocess()`
 * changes the OUTPUT shape, so its inner keys would be a lie — those stay
 * `undefined` (silent), deliberately. Zod 4 keeps `.shape` through `.refine()`
 * and never enters the loop. Bounded depth, so a cyclic duck cannot hang us.
 */
export function schemaFieldKeys(schema: unknown): readonly string[] | undefined {
  let s: unknown = schema
  for (let depth = 0; depth < 10; depth++) {
    if (s === null || typeof s !== 'object') return undefined
    const shape: unknown = (s as { shape?: unknown }).shape
    if (shape !== null && typeof shape === 'object') {
      const keys = Object.keys(shape as Record<string, unknown>)
      return keys.length > 0 ? keys : undefined
    }
    // Zod 3 ZodEffects: follow `_def.schema` for refinements only.
    const def = (s as { _def?: { effect?: { type?: unknown }; schema?: unknown } })._def
    if (def?.schema !== undefined && def.effect?.type === 'refinement') {
      s = def.schema
      continue
    }
    return undefined
  }
  return undefined
}

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

// ─── resolveDescribeFieldIds (#946) ───────────────────────────────────────

/**
 * Resolve the persisted-schema `fieldIds` map for `describeAsync()`'s
 * `BuildDescriptionInput` (#946). Returns a spreadable partial so the call
 * site can inline it with `...(await resolveDescribeFieldIds(...))` without
 * an intermediate local — `collection.ts`'s `describe()` bodies are under a
 * near-zero line-ceiling headroom.
 *
 * Silent-degrades to `{}` (no ids — every `DescribedField.id` stays
 * `undefined`, never a describe() crash) on any failure: `getDEK` throwing,
 * no persisted envelope yet, or an envelope with no `fieldIds` (legacy /
 * never-persisted). Mirrors the leak/degrade posture of
 * `satellites/dead-filter.ts`'s `liveBaseIdSetsForBundle`, but degrading to
 * "no ids" is lossless here (unlike that filter's data-exposure tradeoff) —
 * describe() simply omits `id` for every field.
 */
export async function resolveDescribeFieldIds(
  store: NoydbStore,
  vaultName: string,
  collectionName: string,
  getDEK: (collectionName: string) => Promise<EnclaveKey>,
): Promise<{ fieldIds?: Record<string, string> }> {
  let dek: EnclaveKey
  try {
    dek = await getDEK(collectionName)
  } catch {
    return {}
  }
  const persisted = await loadPersistedSchema(store, vaultName, collectionName, dek)
  return persisted?.fieldIds !== undefined ? { fieldIds: persisted.fieldIds } : {}
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
  /** Native lookup()/enumOf()/dict() fields (#650 Task 2) — declared only via `viaFields`/`via()`, no sugar key. */
  readonly lookupFields?: Record<string, LookupDescriptor> | undefined
  readonly computed: ComputedFields | undefined
  readonly refs: Record<string, RefDescriptor>
  /** Async path fills this; sync path passes `undefined`. */
  readonly zodFields: Record<string, ZodFieldSlot> | undefined
  /**
   * The collection's configured validator, if any. The sync path passes it so
   * `fieldMeta` keys can still be validated (#1253): field KEYS are readable
   * synchronously via {@link schemaFieldKeys} even though field TYPES are not.
   * `undefined` means no validator is configured, which is itself informative
   * — the config keys are then the complete field set.
   */
  readonly schema?: unknown
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
  /** Graph-computed taint overlay (#638 Task 3) — `Collection.via?.taint`. */
  readonly taint?: { readonly postures: ReadonlyMap<string, ViaPosture>; readonly provenance?: ReadonlyMap<string, readonly string[]> } | undefined
  /**
   * Per-binding `describeFragment()` output, keyed by binding brand (#650
   * Task 7 — first-ever consumer of `NoydbVia.describeFragment`,
   * `via/index.ts:136`). `Collection.describe()`/`describeAsync()` build this
   * from `this.via?.describeFragments()`. The `'lookup'` brand's fragment
   * feeds the `lookup` block below; `'blob'`'s feeds the `blob` block
   * (#657, the second consumer). Other brands' fragments ride along unread
   * until they gain a consumer too.
   */
  readonly viaFragments?: Record<string, Record<string, unknown>> | undefined
  /**
   * Persisted-schema `fieldName -> id` map (#946), resolved by the async
   * describe path via {@link resolveDescribeFieldIds}. The sync path passes
   * no `fieldIds` (no store I/O), so every field's `id` is `undefined` there.
   */
  readonly fieldIds?: Record<string, string> | undefined
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
  /** #650 Task 7 — same 'select' outcome as `dict` (today always co-present for a lookup field via the existing `dict` block; kept as its own check so a future lookup-only field, with no `dict` block, still derives 'select'). */
  lookup?: unknown
  /** #657 — a blobFields-declared field derives the 'file' widget, never the 'text' default (binary content, not a text input). */
  blob?: unknown
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
  if (opts.dict !== undefined || opts.lookup !== undefined) return 'select'
  if (opts.blob !== undefined) return 'file'
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
  const { collection, fieldMeta, moneyFields, dictKeyFields, lookupFields, computed, refs, zodFields, schema, dictLabels, meta, i18nFields, classified, taint, fieldIds } = input

  // #650 Task 7 — the 'lookup' binding's describeFragment, keyed per field.
  // Deliberately routed through `viaFragments` rather than reused directly
  // from `lookupFields` above (which only feeds the pre-existing `dict`
  // block, byte-stable for the alias) — this IS the first-ever
  // `describeFragment` consumption the task wires up.
  const lookupFragments = (input.viaFragments?.['lookup'] as LookupDescribeFragment | undefined)?.lookupFields

  // #657 — the 'blob' binding's describeFragment, keyed per field (same
  // routing pattern as lookupFragments above). A blobFields-declared field
  // has no other config-map source (unlike money/dict/lookup/i18n/classified,
  // each of which is fed a dedicated map below) — `blobFragments` is BOTH
  // this field's block source AND (via its keys) how it joins `allKeys` at
  // all, since otherwise a blobFields-only field with no fieldMeta entry is
  // invisible in describe() (#657 finding 1).
  const blobFragments = (input.viaFragments?.['blob'] as BlobDescribeFragment | undefined)?.blobFields

  // Validate fieldMeta keys against the real known-field set = config keys ∪ the
  // validator's fields. Sound whenever that set can be enumerated COMPLETELY:
  //
  //   async path   zodFields is non-empty      — derived types carry the keys
  //   sync path    `.shape` was readable       — no derivation, no peer dep (#1253)
  //
  // Silent in EVERY other case, and the third one is the instructive one. It is
  // tempting to reason "no validator configured, therefore the config keys are the
  // whole field set" — that is FALSE. A collection may be typed by a TypeScript
  // generic alone (`v.collection<Sale>('sales', { moneyFields: … })`), whose fields
  // are real, are present in the data, and are legitimately named by `fieldMeta`,
  // yet appear in NO runtime config. Guarding there rejects correct code.
  //
  // So these are deliberate false NEGATIVES on both counts: an unreadable validator
  // and an absent one. A rule that over-fires teaches people to stop declaring
  // fieldMeta at all, which costs more than the typos it would catch.
  //
  // Before #1253 this ran on the async path alone, so a typo'd key on the sync path
  // became a phantom field carrying its `sensitivity` while the real field went
  // undescribed — see schemaFieldKeys() for why that was thought unavoidable.
  const validatorKeys = zodFields !== undefined && Object.keys(zodFields).length > 0
    ? Object.keys(zodFields)
    : schemaFieldKeys(schema)
  const canEnumerateFields = validatorKeys !== undefined
  if (canEnumerateFields && fieldMeta !== undefined) {
    const knownFields = new Set<string>([
      ...Object.keys(moneyFields ?? {}),
      ...Object.keys(dictKeyFields ?? {}),
      ...Object.keys(refs),
      ...Object.keys(computed ?? {}),
      ...(validatorKeys ?? []),
      ...Object.keys(i18nFields ?? {}),
      ...Object.keys(lookupFields ?? {}),
      ...Object.keys(blobFragments ?? {}),
      ...Object.keys(classified ?? {}),
    ])
    validateFieldMetaKeys(collection, fieldMeta, knownFields)
  }

  // Union of all config key sources — stable alphabetical order.
  const allKeys = new Set<string>([
    ...Object.keys(moneyFields ?? {}),
    ...Object.keys(dictKeyFields ?? {}),
    ...Object.keys(lookupFields ?? {}),
    ...Object.keys(refs),
    ...Object.keys(computed ?? {}),
    ...Object.keys(fieldMeta ?? {}),
    ...Object.keys(zodFields ?? {}),
    ...Object.keys(i18nFields ?? {}),
    ...Object.keys(classified ?? {}),
    ...Object.keys(blobFragments ?? {}),
  ])

  const fields: DescribedField[] = []

  for (const key of [...allKeys].sort()) {
    const zod = zodFields?.[key]
    // Narrow the opaque marker back to the concrete descriptor — see the
    // {@link BuildDescriptionInput.moneyFields} doc comment.
    const money = moneyFields?.[key] as MoneyDescriptor | undefined
    const dict = dictKeyFields?.[key]
    const lookupDesc = lookupFields?.[key]
    const refDesc = refs[key]
    const isComputed = computed !== undefined && key in computed
    const i18nDesc = i18nFields?.[key]
    const cls = classified?.[key]
    const blobFragmentEntry: BlobDescribeFragmentEntry | undefined = blobFragments?.[key]
    const taintPosture = taint?.postures.get(key)

    // ── Infer type + structural extras ────────────────────────────────────
    let type = zod?.type ?? 'unknown'
    const inferred: Partial<FieldMeta> = {}

    let moneyBlock: DescribedField['money'] | undefined
    let dictBlock: DescribedField['dict'] | undefined
    let refBlock: DescribedField['ref'] | undefined
    let lookupBlock: DescribedField['lookup'] | undefined
    let blobBlock: DescribedField['blob'] | undefined

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
    } else if (lookupDesc) {
      // Native lookup()/enumOf()/dict() field (#650 Task 2) — the SAME `dict`
      // block shape as above, for byte-parity with the dictKey()/staticDict()
      // alias. A table-bearing descriptor ('static' backing, the lookup(static)
      // form staticDict() compiles onto) resolves synchronously like a static
      // dict; a reserved-tier dict() resolves via `dictLabels` exactly like a
      // dynamic dictKey (review fix — was previously falling to the
      // declared-keys-only fallback below, breaking async describe parity);
      // everything else (collection/bare enum) falls to that fallback.
      type = 'enum'
      const lookupLabelMap = dictLabels?.[lookupDesc.dimension]
      const lookupLabelMapHasEntries = lookupLabelMap !== undefined && Object.keys(lookupLabelMap).length > 0
      if (lookupDesc.table !== undefined) {
        const displayLocale = lookupDesc.displayLocale
        const table = lookupDesc.table
        const values = (lookupDesc.keys ?? Object.keys(table)).map((k) => {
          const localeMap = table[k]
          const label = displayLocale !== undefined
            ? (localeMap?.[displayLocale] ?? undefined)
            : undefined
          return label !== undefined ? { value: k, label } : { value: k }
        })
        dictBlock = { name: lookupDesc.dimension, static: true, values }
      } else if (lookupLabelMapHasEntries) {
        const values = Object.entries(lookupLabelMap).map(([value, label]) => ({ value, label }))
        dictBlock = { name: lookupDesc.dimension, static: false, values }
      } else if (lookupDesc.keys !== undefined) {
        const values = lookupDesc.keys.map((k) => {
          const label = lookupDesc.labels?.[k]
          return label !== undefined ? { value: k, label } : { value: k }
        })
        dictBlock = { name: lookupDesc.dimension, static: false, values }
      } else {
        dictBlock = { name: lookupDesc.dimension, static: false }
      }
    } else if (i18nDesc) {
      // i18nText field: the stored value is a locale-map object, but the resolved
      // type exposed to consumers is 'string' (locale resolution collapses to a string).
      type = 'string'
    } else if (isComputed) {
      // type already initialized to zod?.type ?? 'unknown' above; no re-set needed
    } else if (blobFragmentEntry !== undefined) {
      // #657 finding 1 — a blobFields-only field (no schema/money/dict/
      // lookup/i18n config) was previously invisible; with a fieldMeta
      // entry it fell through to the 'unknown'/'text'/editable:true default,
      // actively wrong for binary content. `type` is a plain `string` on
      // DescribedField (not a closed union), so 'blob' is not a breaking
      // union extension.
      type = 'blob'
      blobBlock = { ...blobFragmentEntry, queryable: 'none' }
    }

    // ── lookup block (#650 Task 7 — first-ever NoydbVia.describeFragment
    // consumer) ── Sourced from `lookupFragments` (the binding's fragment),
    // NOT from `lookupDesc` above (which only feeds the pre-existing `dict`
    // block, byte-stable for the alias) — routing through the fragment is
    // the point: `backing`/`vocabulary`/`key`/`onDelete` have no other
    // source in this function, so their presence here is itself proof the
    // describeFragment seam (declared via/index.ts:136, zero consumers before
    // this task) carries data end to end from binding to describe() output.
    const lookupFragmentEntry: LookupDescribeFragmentEntry | undefined = lookupFragments?.[key]
    if (lookupFragmentEntry !== undefined) {
      lookupBlock = {
        ...(lookupFragmentEntry.dimension !== undefined ? { dimension: lookupFragmentEntry.dimension } : {}),
        backing: lookupFragmentEntry.backing,
        vocabulary: lookupFragmentEntry.vocabulary,
        key: lookupFragmentEntry.key,
        onDelete: lookupFragmentEntry.onDelete,
        ...(lookupFragmentEntry.altKeys !== undefined ? { altKeys: lookupFragmentEntry.altKeys } : {}),
        ...(lookupFragmentEntry.present !== undefined ? { present: lookupFragmentEntry.present } : {}),
        ...(lookupFragmentEntry.sortBy !== undefined ? { sortBy: lookupFragmentEntry.sortBy } : {}),
        ...(lookupFragmentEntry.keys !== undefined ? { keys: lookupFragmentEntry.keys } : {}),
      }
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
      ...(lookupBlock !== undefined ? { lookup: lookupBlock } : {}),
      ...(blobBlock !== undefined ? { blob: blobBlock } : {}),
      ...(resolved.widget !== undefined ? { resolvedWidget: resolved.widget } : {}),
    })

    // ── Editable: false for computed, id, provenance-stamped, blob fields ──
    // Provenance fields (_source, _sourceTs) are envelope-level metadata, not
    // user schema fields — they won't appear as keys in fieldMeta so this check
    // is implicitly handled (they'd never appear in allKeys). Explicitly guard
    // computed + 'id' as the two structural non-editable cases. A blobFields
    // field (#657) is never written through the record codec — it's mutated
    // exclusively via `collection.blob(id)` — so it is never editable either.
    const editable = !isComputed && key !== 'id' && blobBlock === undefined

    // ── Assemble the field (exactOptionalPropertyTypes-safe spreads) ───────
    const field: DescribedField = {
      key,
      ...(fieldIds?.[key] !== undefined ? { id: fieldIds[key] } : {}),
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
      ...(lookupBlock !== undefined ? { lookup: lookupBlock } : {}),
      ...(blobBlock !== undefined ? { blob: blobBlock } : {}),
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
      ...(taintPosture !== undefined ? { taint: { posture: taintPosture, forcedBy: taint?.provenance?.get(key) ?? [] } } : {}),
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
