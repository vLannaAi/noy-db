/**
 * Minimal OOXML reader. Inverse of `writeXlsx` in `xlsx.ts`.
 *
 * Walks the three parts the writer emits:
 *
 *   - `xl/sharedStrings.xml`       → string table (idx → string)
 *   - `xl/workbook.xml`            → sheet name list (with sheetId)
 *   - `xl/_rels/workbook.xml.rels` → sheetId → sheet part path
 *   - `xl/worksheets/sheet<N>.xml` → cell data
 *
 * Cell types matched to the writer's emission rules:
 *   - no `t` attribute → number (`<v>` is parsed as Number)
 *   - `t="s"`         → shared-string ref
 *   - `t="b"`         → boolean (`1` ↔ true, `0` ↔ false)
 *   - empty `<c />`   → undefined
 *
 * Excel date serials are NOT auto-converted — the writer outputs ISO-
 * 8601 strings via the shared-string path, so dates round-trip as
 * strings unless the consumer opts into `dateFields` coercion (handled
 * one layer up in `index.ts:fromBytes`).
 *
 * @module
 */

import { readZip } from '@noy-db/as-zip'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

const PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => name === 'sheet' || name === 'row' || name === 'c' || name === 'si' || name === 'Relationship',
})

/** A row of cell values keyed by column letter (`'A' → 'foo'`). */
export type ReadXlsxRow = Record<string, unknown>

export interface ReadXlsxSheet {
  /** Sheet tab name from `xl/workbook.xml`. */
  readonly name: string
  /** All rows in declaration order. Columns indexed by Excel letter. */
  readonly rows: readonly ReadXlsxRow[]
}

export interface ReadXlsxResult {
  readonly sheets: readonly ReadXlsxSheet[]
}

/**
 * Decode an `.xlsx` (OOXML) byte stream into per-sheet row data. The
 * caller decides what to do with the rows (header inference, type
 * coercion, record building) — the reader stays format-only.
 *
 * Throws on malformed XML, missing parts, or sheet-id mismatches.
 */
export async function readXlsx(bytes: Uint8Array): Promise<ReadXlsxResult> {
  const entries = await readZip(bytes)
  const partByPath = new Map<string, Uint8Array>()
  for (const e of entries) partByPath.set(e.path, e.bytes)

  const sharedStrings = readSharedStrings(partByPath.get('xl/sharedStrings.xml'))
  const sheetMeta = readWorkbook(partByPath.get('xl/workbook.xml'))
  const rels = readWorkbookRels(partByPath.get('xl/_rels/workbook.xml.rels'))

  const sheets: ReadXlsxSheet[] = []
  for (const meta of sheetMeta) {
    const target = rels.get(meta.rId)
    if (target === undefined) {
      throw new Error(
        `as-xlsx.readXlsx: workbook references rId="${meta.rId}" but the rels file has no matching target`,
      )
    }
    const sheetPath = `xl/${target}`
    const sheetBytes = partByPath.get(sheetPath)
    if (sheetBytes === undefined) {
      throw new Error(`as-xlsx.readXlsx: missing sheet part ${sheetPath}`)
    }
    sheets.push({
      name: meta.name,
      rows: readSheet(sheetBytes, sharedStrings),
    })
  }

  return { sheets }
}

// ── XML helpers ─────────────────────────────────────────────────────

function decodeXml(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function parseStrict(xml: string, where: string): unknown {
  const validation = XMLValidator.validate(xml)
  if (validation !== true) {
    const err = validation.err
    throw new Error(
      `as-xlsx.readXlsx: ${where} is not valid XML (${err.code} at line ${err.line}: ${err.msg})`,
    )
  }
  try {
    return PARSER.parse(xml)
  } catch (err) {
    throw new Error(`as-xlsx.readXlsx: failed to parse ${where} (${(err as Error).message})`)
  }
}

// ── sharedStrings.xml ───────────────────────────────────────────────

function readSharedStrings(bytes: Uint8Array | undefined): readonly string[] {
  // The writer always emits sharedStrings.xml, but a hand-crafted
  // .xlsx might omit it if no string cells are present. Treat missing
  // as an empty table so cells with t="s" surface as a clear error
  // ("ref out of bounds") rather than a misleading null.
  if (bytes === undefined) return []
  const parsed = parseStrict(decodeXml(bytes), 'xl/sharedStrings.xml')
  const sst = (parsed as Record<string, unknown>).sst
  if (sst === null || sst === undefined || typeof sst !== 'object') return []
  const items = (sst as { si?: unknown[] }).si ?? []
  if (!Array.isArray(items)) return []

  return items.map((si): string => {
    if (si === null || typeof si !== 'object') return ''
    const t = (si as { t?: unknown }).t
    return textValue(t)
  })
}

// ── workbook.xml ────────────────────────────────────────────────────

interface WorkbookSheetMeta {
  readonly name: string
  readonly sheetId: string
  readonly rId: string
}

function readWorkbook(bytes: Uint8Array | undefined): readonly WorkbookSheetMeta[] {
  if (bytes === undefined) {
    throw new Error('as-xlsx.readXlsx: missing xl/workbook.xml')
  }
  const parsed = parseStrict(decodeXml(bytes), 'xl/workbook.xml')
  const workbook = (parsed as Record<string, unknown>).workbook
  if (workbook === null || workbook === undefined || typeof workbook !== 'object') {
    throw new Error('as-xlsx.readXlsx: xl/workbook.xml has no <workbook> root')
  }
  const sheetsObj = (workbook as { sheets?: unknown }).sheets
  if (sheetsObj === null || sheetsObj === undefined || typeof sheetsObj !== 'object') {
    return []
  }
  const sheetEntries = (sheetsObj as { sheet?: unknown[] }).sheet ?? []
  if (!Array.isArray(sheetEntries)) return []

  return sheetEntries.map((s): WorkbookSheetMeta => {
    const obj = s as Record<string, unknown>
    return {
      name: stringAttr(obj['@_name']),
      sheetId: stringAttr(obj['@_sheetId']),
      rId: stringAttr(obj['@_r:id']) || stringAttr(obj['@_id']),
    }
  })
}

// ── workbook.xml.rels ───────────────────────────────────────────────

function readWorkbookRels(bytes: Uint8Array | undefined): Map<string, string> {
  // Map of relationship id → target path (relative to xl/).
  if (bytes === undefined) {
    throw new Error('as-xlsx.readXlsx: missing xl/_rels/workbook.xml.rels')
  }
  const parsed = parseStrict(decodeXml(bytes), 'xl/_rels/workbook.xml.rels')
  const root = (parsed as Record<string, unknown>).Relationships
  if (root === null || root === undefined || typeof root !== 'object') {
    return new Map()
  }
  const rels = (root as { Relationship?: unknown[] }).Relationship ?? []
  if (!Array.isArray(rels)) return new Map()

  const map = new Map<string, string>()
  for (const r of rels) {
    const obj = r as Record<string, unknown>
    const id = stringAttr(obj['@_Id'])
    const target = stringAttr(obj['@_Target'])
    if (id) map.set(id, target)
  }
  return map
}

// ── sheet<N>.xml ────────────────────────────────────────────────────

function readSheet(bytes: Uint8Array, sharedStrings: readonly string[]): ReadXlsxRow[] {
  const parsed = parseStrict(decodeXml(bytes), 'sheet')
  const ws = (parsed as Record<string, unknown>).worksheet
  if (ws === null || ws === undefined || typeof ws !== 'object') return []
  const sheetData = (ws as { sheetData?: unknown }).sheetData
  if (sheetData === null || sheetData === undefined || typeof sheetData !== 'object') return []
  const rowEntries = (sheetData as { row?: unknown[] }).row ?? []
  if (!Array.isArray(rowEntries)) return []

  const rows: ReadXlsxRow[] = []
  for (const row of rowEntries) {
    if (row === null || typeof row !== 'object') {
      rows.push({})
      continue
    }
    const cells = (row as { c?: unknown[] }).c ?? []
    if (!Array.isArray(cells)) {
      rows.push({})
      continue
    }
    const out: ReadXlsxRow = {}
    for (const c of cells) {
      if (c === null || typeof c !== 'object') continue
      const cellObj = c as Record<string, unknown>
      const ref = stringAttr(cellObj['@_r'])
      if (!ref) continue
      const col = letterFromRef(ref)
      const t = cellObj['@_t']
      const v = cellObj['v']
      const text = textValue(v)
      if (text === '') {
        if (t === 's') {
          out[col] = ''
          continue
        }
        // Empty <c r="A1"/> — leave undefined (caller can drop).
        continue
      }
      if (t === 's') {
        const idx = Number(text)
        if (!Number.isInteger(idx) || idx < 0 || idx >= sharedStrings.length) {
          throw new Error(
            `as-xlsx.readXlsx: shared-string reference ${idx} out of range ` +
              `(table has ${sharedStrings.length} entries)`,
          )
        }
        out[col] = sharedStrings[idx]
      } else if (t === 'b') {
        out[col] = text === '1'
      } else if (t === 'str' || t === 'inlineStr') {
        // Inline strings — writer never emits these but readers should
        // accept them since some upstream tools default to inline.
        out[col] = text
      } else {
        // Numeric cell (no `t` attribute, or t="n").
        const n = Number(text)
        out[col] = Number.isFinite(n) ? n : text
      }
    }
    rows.push(out)
  }
  return rows
}

/**
 * Extract column letters from an A1-style reference (`"BC42"` → `"BC"`).
 * Used to build the sparse `Record<column, value>` row shape.
 */
function letterFromRef(ref: string): string {
  let i = 0
  while (i < ref.length && /[A-Z]/.test(ref[i]!)) i++
  return ref.slice(0, i)
}

/**
 * fast-xml-parser surfaces text-only elements as primitives or as
 * objects with a `#text` field when other attributes are present.
 * Normalize to a string.
 */
function textValue(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  if (typeof raw === 'object') {
    const txt = (raw as { '#text'?: unknown })['#text']
    if (txt !== undefined) return textValue(txt)
  }
  return ''
}

/**
 * Stringify a fast-xml-parser attribute value. Attributes come through
 * as primitives; defensively narrow before `String()` so the lint rule
 * (`@typescript-eslint/no-base-to-string`) is satisfied. Anything not
 * a primitive is coerced to the empty string — silent failures here
 * surface as missing parts (e.g. unknown rId) downstream.
 */
function stringAttr(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return ''
}
