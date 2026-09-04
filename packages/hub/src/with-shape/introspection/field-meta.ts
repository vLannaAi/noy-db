/**
 * Consumer-neutral, data-relatable field descriptors — the canonical,
 * validator-agnostic authoring channel. Merged by `collection.describe()`.
 *
 * Descriptive, never prescriptive: label/semanticType/unit/sensitivity/
 * aggregate/aliases/displayFor only. Layout, styling, and active-locale
 * selection stay app-side.
 *
 * @module
 */

/** Known semantic types; the union is open — unknown strings pass through. */
export type SemanticType =
  | 'date' | 'datetime' | 'email' | 'url' | 'currency' | 'percent'
  | 'country' | 'vat' | 'iban' | 'entity'
  | (string & {})

export interface FieldMeta {
  /** Human label for any displayable field. Required. */
  label: string
  description?: string
  semanticType?: SemanticType
  /** Display unit, e.g. '€', '%', 'kg'. */
  unit?: string
  /** Data classification driving redaction/inspector masking. */
  sensitivity?: 'public' | 'pii' | 'secret'
  /**
   * Sensitivity that is a property of the READ SHAPE, not the value (#1251).
   *
   * ⚠️ Declaring this prevents nothing. Against an insider holding the device
   * and local keys it is TELEMETRY: it lets an opt-in sensor make bulk
   * extraction visible early, attributable and loud. The real remediation is
   * key custody — tiers and per-collection DEKs — not this label.
   *
   * Reads as: *this field's collection is a corpus whose COVERAGE is a
   * protected quantity.* Deliberately ORTHOGONAL to {@link FieldMeta.sensitivity}:
   * a company tax id stays `'public'` (it is public by law) and is still
   * `bulk: 'sensitive'`, because the book of business is the set, not the value.
   *
   * The kernel does NOTHING with it beyond carrying it through introspection
   * (`describe()` / `dumpSchema()`), so a sensor can discover which
   * collections to account for. Zero runtime cost when unused.
   */
  bulk?: 'sensitive'
  /** Default aggregation for this field. */
  aggregate?: 'sum' | 'count' | 'distinct' | 'none'
  /** Canonical search synonyms (data vocabulary, not UI). */
  aliases?: readonly string[]
  /** Entity pairing: the field holding the human label for this id (buyerId → buyerName). */
  displayFor?: string
  /**
   * Override the widget hint derived from semanticType/type.
   * e.g. 'textarea', 'date', 'money', 'select', 'checkbox', 'number', 'text'.
   * When absent, the widget is derived automatically by buildDescription.
   */
  widget?: string
  /**
   * Card/section grouping hint for detail & form layouts (e.g. 'Identity',
   * 'Amounts'). Purely descriptive metadata — consumers group; describe()
   * keeps emitting fields alphabetically.
   */
  group?: string
  /** Relative ordering hint within (and across) groups. Lower renders first. */
  order?: number
}

export class FieldMetaUnknownFieldError extends Error {
  constructor(public readonly collection: string, public readonly key: string) {
    super(`fieldMeta for collection "${collection}" references unknown field "${key}". `
      + `Declare it in the schema/config or remove the fieldMeta entry.`)
    this.name = 'FieldMetaUnknownFieldError'
  }
}

/** Reject fieldMeta keys that are not known fields (typo guard), fail-loud. */
export function validateFieldMetaKeys(
  collection: string,
  fieldMeta: Record<string, FieldMeta>,
  knownFields: ReadonlySet<string>,
): void {
  for (const key of Object.keys(fieldMeta)) {
    if (!knownFields.has(key)) throw new FieldMetaUnknownFieldError(collection, key)
  }
}

export interface MergeInputs {
  channel?: FieldMeta
  zodMeta?: Partial<FieldMeta>
  inferred?: Partial<FieldMeta>
}
export interface ResolvedMeta extends Partial<FieldMeta> { label: string }

/** camelCase / snake_case → Title Case words. */
export function humanizeFieldKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Merge one field's metadata: channel > zodMeta > inferred; label always present. */
export function resolveFieldMeta(key: string, inputs: MergeInputs): ResolvedMeta {
  const { channel, zodMeta, inferred } = inputs
  const pick = <K extends keyof FieldMeta>(k: K): FieldMeta[K] | undefined =>
    channel?.[k] ?? zodMeta?.[k] ?? inferred?.[k]
  const description = pick('description')
  const semanticType = pick('semanticType')
  const unit = pick('unit')
  const sensitivity = pick('sensitivity')
  const bulk = pick('bulk')
  const aggregate = pick('aggregate')
  const aliases = pick('aliases')
  const displayFor = pick('displayFor')
  const widget = pick('widget')
  const group = pick('group')
  const order = pick('order')
  return {
    label: pick('label') ?? humanizeFieldKey(key),
    ...(description !== undefined ? { description } : {}),
    ...(semanticType !== undefined ? { semanticType } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(sensitivity !== undefined ? { sensitivity } : {}),
    ...(bulk !== undefined ? { bulk } : {}),
    ...(aggregate !== undefined ? { aggregate } : {}),
    ...(aliases !== undefined ? { aliases } : {}),
    ...(displayFor !== undefined ? { displayFor } : {}),
    ...(widget !== undefined ? { widget } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(order !== undefined ? { order } : {}),
  }
}

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
 * Wrappers (reported by the pilot on #1249's guard, and it equally affected
 * #1253's): a wrapped object's `.shape` is undefined, so "has a schema" and
 * "hub can enumerate its fields" silently diverged for exactly the schemas
 * most worth guarding — validated ones.
 *
 * ONE RULE UNWRAPS ALL OF THEM: FOLLOW THE OUTPUT SIDE. These keys describe
 * the PARSED record, so the only question a wrapper raises is whether it
 * changes the parsed shape.
 *
 *   Zod 3 `ZodEffects`  — `.refine()`/`.superRefine()` (`effect.type` is
 *     `'refinement'`) and `z.preprocess()` (`'preprocess'`) both parse WITH
 *     the inner schema, so the output is the inner object: follow
 *     `_def.schema`. `.transform()` REPLACES the output, so the inner keys
 *     would be a lie: stay `undefined`, deliberately.
 *   Zod 4 `ZodPipe`     — `z.preprocess()` is `pipe(transform -> object)` and
 *     `.transform()` is `pipe(object -> transform)`. Following `_def.out`
 *     resolves both correctly with no effect-kind test: preprocess reaches the
 *     object, transform reaches a `ZodTransform` that has no shape and no
 *     inner schema, so the loop returns `undefined` on its own.
 *
 * `preprocess` was the pilot's second finding (#1262): the first fix followed
 * refinements only, which left four of their registered collections unguarded
 * — including the one carrying their only `fieldMeta` PII declaration, i.e.
 * precisely the collection #1253 was written for. It is one string away from
 * `transform` and means the opposite thing, so a test pins the two apart.
 *
 * A duck-typed probe throughout: an unrecognised validator returns `undefined`
 * and the caller stays silent rather than guessing. Bounded depth, so a cyclic
 * duck cannot hang us.
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
    const def = (s as {
      _def?: { effect?: { type?: unknown }; schema?: unknown; out?: unknown }
    })._def
    // Zod 3 ZodEffects: refinement and preprocess parse WITH the inner schema,
    // so the output shape is the inner object's. `transform` replaces it.
    const effect = def?.effect?.type
    if (def?.schema !== undefined && (effect === 'refinement' || effect === 'preprocess')) {
      s = def.schema
      continue
    }
    // Zod 4 ZodPipe: the output side IS the parsed shape. `z.preprocess` puts
    // the object there; `.transform()` puts a shapeless ZodTransform there,
    // which falls out of the loop as `undefined` on the next pass.
    if (def?.out !== undefined) {
      s = def.out
      continue
    }
    return undefined
  }
  return undefined
}

/**
 * Registration-time `fieldMeta` key check (#1253 follow-up, the "refuse as early
 * as the information allows" pass).
 *
 * The same validation `buildDescription` runs, hoisted to collection
 * construction so a typo is refused when it is DECLARED rather than when
 * someone happens to call `describe()`. A collection nobody describes was
 * previously never checked at all — and `fieldMeta` is what carries
 * `sensitivity`, so the un-checked case was the one with a data-classification
 * inventory hanging off it.
 *
 * Deliberately NOT a replacement for the check inside `buildDescription`. There
 * are three tiers of knowability, not two:
 *
 *   always      — a name declared in the config itself (see the virtual-field
 *                 refusal in the derivation registry: "declared and never
 *                 stored" needs no schema at all)
 *   at reg.     — a validator whose `.shape` is readable synchronously: THIS
 *   at describe — a validator whose fields only exist after async JSON-Schema
 *                 derivation (Zod 3 + `zod-to-json-schema`)
 *
 * The third tier is why `buildDescription` keeps its own call. Hoisting alone
 * would move the check earlier for some collections and REMOVE it for others.
 *
 * Silent when the field set cannot be enumerated, exactly as the describe-time
 * check is: a TS-generic collection names real fields that appear in no runtime
 * config, and rejecting those teaches people to stop declaring `fieldMeta`.
 */
export function validateFieldMetaAtRegistration(input: {
  readonly collection: string
  readonly schema?: unknown
  readonly fieldMeta?: Record<string, unknown> | undefined
  readonly configKeys: readonly string[]
}): void {
  if (input.fieldMeta === undefined) return
  const validatorKeys = schemaFieldKeys(input.schema)
  if (validatorKeys === undefined) return
  validateFieldMetaKeys(
    input.collection,
    input.fieldMeta as Parameters<typeof validateFieldMetaKeys>[1],
    new Set<string>([...validatorKeys, ...input.configKeys]),
  )
}
