/**
 * #414 P4 Mode B — infer a noy-db schema from an arbitrary workbook.
 *
 * Heuristic by nature (the spec's genuinely-hard part): types come from sampling
 * cell values, foreign keys from value-subset matching against another sheet's
 * id column. Use it to BOOTSTRAP a schema you then review — not as ground truth.
 * Standard Schema validators aren't JSON-serializable, so {@link zodSourceFor}
 * emits a Zod snippet you adopt in code rather than a live validator.
 */
import { readXlsx } from './read.js'

export type InferredType = 'string' | 'number' | 'boolean' | 'date'

export interface InferredField {
  readonly type: InferredType
  /** Target collection (sheet) name when this field looks like a foreign key. */
  readonly references?: string
}

export interface InferredCollection {
  readonly idField: string
  readonly fields: Record<string, InferredField>
}

export interface InferredSchema {
  readonly collections: Record<string, InferredCollection>
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/

function inferType(vals: readonly unknown[]): InferredType {
  if (vals.length === 0) return 'string'
  if (vals.every((v) => typeof v === 'boolean')) return 'boolean'
  if (vals.every((v) => typeof v === 'number')) return 'number'
  if (vals.every((v) => typeof v === 'string' && ISO_DATE.test(v))) return 'date'
  return 'string'
}

interface SheetData {
  name: string
  fields: string[]
  records: Record<string, unknown>[]
}

/**
 * Infer a {@link InferredSchema} from an `.xlsx` byte stream. Sheets whose name
 * starts with `_` (our smart-export meta sheets) are skipped; pass `skipSheets`
 * to exclude more (e.g. summary sheets).
 */
export async function inferSchema(
  bytes: Uint8Array,
  options: { skipSheets?: readonly string[] } = {},
): Promise<InferredSchema> {
  const skip = new Set(options.skipSheets ?? [])
  const decoded = await readXlsx(bytes)

  const sheets: SheetData[] = []
  for (const sh of decoded.sheets) {
    if (sh.name.startsWith('_') || skip.has(sh.name)) continue
    const headerRow = sh.rows[0] ?? {}
    const colToField = new Map<string, string>()
    const fields: string[] = []
    for (const [letter, val] of Object.entries(headerRow)) {
      const name =
        typeof val === 'string' ? val.trim() : typeof val === 'number' || typeof val === 'boolean' ? String(val) : ''
      if (!name) continue
      colToField.set(letter, name)
      fields.push(name)
    }
    const records = sh.rows.slice(1).map((row) => {
      const rec: Record<string, unknown> = {}
      for (const [letter, val] of Object.entries(row)) {
        const f = colToField.get(letter)
        if (f !== undefined) rec[f] = val
      }
      return rec
    })
    sheets.push({ name: sh.name, fields, records })
  }

  const valuesOf = (s: SheetData, f: string): unknown[] =>
    s.records.map((r) => r[f]).filter((v) => v != null && v !== '')

  const idFieldOf = (s: SheetData): string => {
    if (s.fields.includes('id')) return 'id'
    // First field whose non-null values are all unique → a natural key.
    for (const f of s.fields) {
      const vals = valuesOf(s, f)
      if (vals.length > 0 && new Set(vals.map((v) => String(v))).size === vals.length) return f
    }
    return s.fields[0] ?? 'id'
  }

  const meta = sheets.map((s) => ({ s, idField: idFieldOf(s) }))
  const idValuesByName = new Map<string, Set<string>>()
  for (const { s, idField } of meta) {
    idValuesByName.set(s.name, new Set(valuesOf(s, idField).map((v) => String(v))))
  }

  const collections: Record<string, InferredCollection> = {}
  for (const { s, idField } of meta) {
    const fields: Record<string, InferredField> = {}
    for (const f of s.fields) {
      const vals = valuesOf(s, f)
      const type = inferType(vals)
      let references: string | undefined
      if (f !== idField && type === 'string' && vals.length > 0) {
        const distinct = new Set(vals.map((v) => String(v)))
        for (const { s: other } of meta) {
          if (other.name === s.name) continue
          const ids = idValuesByName.get(other.name)
          if (ids && ids.size > 0 && [...distinct].every((v) => ids.has(v))) {
            references = other.name
            break
          }
        }
      }
      fields[f] = references ? { type, references } : { type }
    }
    collections[s.name] = { idField, fields }
  }
  return { collections }
}

/** Emit a Zod schema snippet (guidance) from an {@link InferredSchema}. */
export function zodSourceFor(schema: InferredSchema): string {
  const zType = (t: InferredType): string =>
    t === 'number' ? 'z.number()' : t === 'boolean' ? 'z.boolean()' : t === 'date' ? 'z.string().datetime()' : 'z.string()'
  const blocks = [`import { z } from 'zod'`]
  for (const [name, c] of Object.entries(schema.collections)) {
    const lines = Object.entries(c.fields).map(
      ([f, d]) => `  ${f}: ${zType(d.type)},${d.references ? ` // → ${d.references}` : ''}`,
    )
    blocks.push(`export const ${name}Schema = z.object({\n${lines.join('\n')}\n})`)
  }
  return blocks.join('\n\n')
}
