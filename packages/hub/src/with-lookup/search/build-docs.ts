/**
 * Map a decrypted record's configured text fields → IndexDoc field entries
 * (L1). String, i18nText, dictKey, and blob-filename expansion. Uses
 * getAtPath for nested/[]-wildcard paths. Blob filenames are NOT inline on the
 * record — the collection pre-resolves them (one listSlots() per record, the
 * heaviest source) and feeds them to {@link buildBlobFieldEntries}.
 */
import { getAtPath } from '../../with-shape/i18n/core.js'
import type { I18nTextDescriptor } from '../../with-shape/i18n/core.js'
import type { DictKeyDescriptor, StaticDictDescriptor } from '../../with-shape/i18n/dictionary.js'
import type { IndexDoc } from './inverted-index.js'

type FieldEntry = IndexDoc['fields'][number]

export function buildStringFieldEntries(
  record: Record<string, unknown>,
  textIndexes: readonly string[],
  only?: readonly string[],
): FieldEntry[] {
  const fields = only ? textIndexes.filter((f) => only.includes(f)) : textIndexes
  const out: FieldEntry[] = []
  for (const field of fields) {
    for (const leaf of getAtPath(record, field)) {
      if (typeof leaf === 'string' && leaf !== '') out.push({ field, text: leaf })
    }
  }
  return out
}

export function buildI18nFieldEntries(
  record: Record<string, unknown>,
  i18nFields: Record<string, I18nTextDescriptor>,
  textIndexes: readonly string[],
  only?: readonly string[],
): FieldEntry[] {
  const fields = (only ? textIndexes.filter((f) => only.includes(f)) : textIndexes).filter((f) => f in i18nFields)
  const out: FieldEntry[] = []
  for (const field of fields) {
    for (const leaf of getAtPath(record, field)) {
      if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf)) continue
      for (const [locale, val] of Object.entries(leaf as Record<string, unknown>)) {
        if (typeof val === 'string' && val !== '') out.push({ field, locale, text: val })
      }
    }
  }
  return out
}

/** label map: field -> (key -> { locale -> label }). Precomputed in the collection (async for dynamic dicts). */
export function buildDictKeyFieldEntries(
  record: Record<string, unknown>,
  dictKeyFields: Record<string, DictKeyDescriptor | StaticDictDescriptor>,
  labelMaps: Map<string, Map<string, Record<string, string>>>,
  textIndexes: readonly string[],
  only?: readonly string[],
): FieldEntry[] {
  const fields = (only ? textIndexes.filter((f) => only.includes(f)) : textIndexes).filter((f) => f in dictKeyFields)
  const out: FieldEntry[] = []
  for (const field of fields) {
    const map = labelMaps.get(field)
    if (!map) continue
    for (const leaf of getAtPath(record, field)) {
      const keys = typeof leaf === 'string' ? [leaf] : Array.isArray(leaf) ? leaf.filter((k): k is string => typeof k === 'string') : []
      for (const key of keys) {
        const labels = map.get(key)
        if (!labels) continue
        for (const [locale, label] of Object.entries(labels)) {
          if (label !== '') out.push({ field, locale, text: label })
        }
      }
    }
  }
  return out
}

/**
 * Blob filenames precomputed in the collection (`field -> filenames[]`, from one
 * async `listSlots()` per record — the heaviest source, see {@link buildBlobFieldEntries}'s
 * caller). Bytes are never tokenized; only the slot `filename` is indexed.
 */
export function buildBlobFieldEntries(filenamesByField: Map<string, string[]>): FieldEntry[] {
  const out: FieldEntry[] = []
  for (const [field, names] of filenamesByField) {
    for (const name of names) if (name !== '') out.push({ field, text: name })
  }
  return out
}
