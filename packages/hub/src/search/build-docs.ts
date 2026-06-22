/**
 * Map a decrypted record's configured text fields → IndexDoc field entries
 * (#308 L1). String fields only here; i18nText / dictKey / blob add their own
 * expansion in later tasks. Uses getAtPath for nested/[]-wildcard paths.
 */
import { getAtPath } from '../i18n/core.js'
import type { I18nTextDescriptor } from '../i18n/core.js'
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
