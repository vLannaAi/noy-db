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
  /** Default aggregation for this field. */
  aggregate?: 'sum' | 'count' | 'distinct' | 'none'
  /** Canonical search synonyms (data vocabulary, not UI). */
  aliases?: readonly string[]
  /** Entity pairing: the field holding the human label for this id (buyerId → buyerName). */
  displayFor?: string
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
  const aggregate = pick('aggregate')
  const aliases = pick('aliases')
  const displayFor = pick('displayFor')
  return {
    label: pick('label') ?? humanizeFieldKey(key),
    ...(description !== undefined ? { description } : {}),
    ...(semanticType !== undefined ? { semanticType } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(sensitivity !== undefined ? { sensitivity } : {}),
    ...(aggregate !== undefined ? { aggregate } : {}),
    ...(aliases !== undefined ? { aliases } : {}),
    ...(displayFor !== undefined ? { displayFor } : {}),
  }
}
