/**
 * Minimal zero-dependency XLSX writer.
 *
 * An `.xlsx` file is a ZIP archive (Office Open XML / OOXML) with
 * SpreadsheetML inside. This writer emits the six parts needed for
 * a valid worksheet and hands them to `@noy-db/as-zip`'s
 * `writeZip()` to assemble the final `.xlsx` bytes.
 *
 * ## Emitted parts
 *
 * ```
 * [Content_Types].xml            # MIME descriptors
 * _rels/.rels                    # root → workbook pointer
 * xl/workbook.xml                # sheet list
 * xl/_rels/workbook.xml.rels     # sheet-part pointers
 * xl/worksheets/sheet<N>.xml     # cell data
 * xl/sharedStrings.xml           # string pool (Unicode-safe)
 * ```
 *
 * Strings route through the shared-string table (`sharedStrings.xml`)
 * rather than being inlined on cells, which is:
 *
 *   1. Slightly more compact when strings repeat (client names,
 *      status labels, locale codes).
 *   2. Consistent with how Excel writes its own files — some
 *      strict-OOXML readers refuse inline strings.
 *
 * Numbers, booleans, and dates are written as typed cells; strings
 * and everything else fall back to the shared-string path.
 *
 * ## Not supported
 *
 * - Cell styles (fonts, colours, borders, number formats).
 * - Formulas, merged cells, frozen panes, auto-filter.
 * - Charts, images, drawings.
 * - Zip64 / archives > 4 GiB.
 *
 * @module
 */

import { writeZip, type ZipEntry } from '@noy-db/as-zip'

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const ENCODER = new TextEncoder()

/** One row in a sheet. Values are coerced per type at emit time. */
export type XlsxRow = ReadonlyArray<unknown>

/** One sheet in a workbook. */
export interface XlsxSheet {
  /** Sheet tab name — Excel caps at 31 chars; we truncate with `…`. */
  readonly name: string
  /** Header row, rendered as row 1. Omit to skip the header. */
  readonly header?: readonly string[]
  /** Data rows — each is an array aligned with `header` if present. */
  readonly rows: readonly XlsxRow[]
}

/**
 * Build a complete `.xlsx` byte stream from the supplied sheet data.
 * Pure — no I/O beyond the internal zip concatenation.
 */
export async function writeXlsx(sheets: readonly XlsxSheet[]): Promise<Uint8Array> {
  if (sheets.length === 0) {
    throw new Error('writeXlsx: at least one sheet is required')
  }

  // Dedup sheet names (Excel rejects duplicates) + truncate to 31 chars.
  const seen = new Set<string>()
  const safeSheets: XlsxSheet[] = sheets.map((s, i) => {
    let name = truncateSheetName(s.name || `Sheet${i + 1}`)
    let n = 1
    while (seen.has(name)) {
      const suffix = `(${n++})`
      name = truncateSheetName(name.slice(0, 31 - suffix.length) + suffix)
    }
    seen.add(name)
    return { ...s, name }
  })

  // Build shared-string table across every sheet. Emit order = insertion order.
  const sharedStrings: string[] = []
  const stringIndex = new Map<string, number>()
  const internString = (s: string): number => {
    const existing = stringIndex.get(s)
    if (existing !== undefined) return existing
    const idx = sharedStrings.length
    sharedStrings.push(s)
    stringIndex.set(s, idx)
    return idx
  }

  // Build the worksheet XML for each sheet — coercing values per type.
  const sheetXmls: string[] = safeSheets.map((sheet) => {
    const lines: string[] = [
      XML_HEADER,
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '<sheetData>',
    ]
    let rowNum = 0
    if (sheet.header && sheet.header.length > 0) {
      rowNum++
      const cells = sheet.header
        .map((h, i) => {
          const idx = internString(String(h))
          return `<c r="${colLetter(i + 1)}${rowNum}" t="s"><v>${idx}</v></c>`
        })
        .join('')
      lines.push(`<row r="${rowNum}">${cells}</row>`)
    }
    for (const row of sheet.rows) {
      rowNum++
      const cells = row
        .map((value, i) => cellXml(value, i + 1, rowNum, internString))
        .join('')
      lines.push(`<row r="${rowNum}">${cells}</row>`)
    }
    lines.push('</sheetData>', '</worksheet>')
    return lines.join('')
  })

  // ── Fixed parts ─────────────────────────────────────────────────

  const sheetEntries = safeSheets.map((s, i) => ({
    index: i + 1,
    id: `rId${i + 1}`,
    name: s.name,
    path: `xl/worksheets/sheet${i + 1}.xml`,
  }))

  const contentTypes = [
    XML_HEADER,
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ...sheetEntries.map(
      (s) =>
        `<Override PartName="/${s.path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ),
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
    '</Types>',
  ].join('')

  const rootRels =
    XML_HEADER +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'

  const workbookXml = [
    XML_HEADER,
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<sheets>',
    ...sheetEntries.map(
      (s) => `<sheet name="${escapeXmlAttr(s.name)}" sheetId="${s.index}" r:id="${s.id}"/>`,
    ),
    '</sheets>',
    '</workbook>',
  ].join('')

  const workbookRels = [
    XML_HEADER,
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...sheetEntries.map(
      (s) =>
        `<Relationship Id="${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.index}.xml"/>`,
    ),
    `<Relationship Id="rIdSharedStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`,
    '</Relationships>',
  ].join('')

  const sharedStringsXml = [
    XML_HEADER,
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`,
    ...sharedStrings.map((s) => `<si><t xml:space="preserve">${escapeXmlText(s)}</t></si>`),
    '</sst>',
  ].join('')

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', bytes: ENCODER.encode(contentTypes) },
    { path: '_rels/.rels', bytes: ENCODER.encode(rootRels) },
    { path: 'xl/workbook.xml', bytes: ENCODER.encode(workbookXml) },
    { path: 'xl/_rels/workbook.xml.rels', bytes: ENCODER.encode(workbookRels) },
    { path: 'xl/sharedStrings.xml', bytes: ENCODER.encode(sharedStringsXml) },
    ...sheetEntries.map((s, i) => ({ path: s.path, bytes: ENCODER.encode(sheetXmls[i] ?? '') })),
  ]

  return await writeZip(entries)
}

// ── Cell emission ─────────────────────────────────────────────────

function cellXml(
  value: unknown,
  colIdx: number,
  rowNum: number,
  intern: (s: string) => number,
): string {
  const ref = `${colLetter(colIdx)}${rowNum}`
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`
  }
  // Date → ISO-8601 string (Excel renders as text unless the cell
  // has a date-format style; styles are out of scope for this
  // minimal writer).
  const s =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'string'
        ? value
        : JSON.stringify(value)
  const idx = intern(s)
  return `<c r="${ref}" t="s"><v>${idx}</v></c>`
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Convert a 1-based column index to Excel A1 letter notation.
 * 1 → A, 26 → Z, 27 → AA, 702 → ZZ, 703 → AAA.
 */
export function colLetter(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const r = (x - 1) % 26
    s = String.fromCharCode(65 + r) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

function truncateSheetName(name: string): string {
  // Excel sheet-name rules: max 31 chars, forbid :/\?*[]
  const cleaned = name.replace(/[:/\\?*[\]]/g, '_')
  if (cleaned.length <= 31) return cleaned
  return cleaned.slice(0, 30) + '…'
}

/** XML text escaping — `& < > \r` (quotes only matter in attributes). */
function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;')
}

/** XML attribute escaping. */
function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, '&quot;')
}
