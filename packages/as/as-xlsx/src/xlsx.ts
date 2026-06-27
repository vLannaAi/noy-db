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

/**
 * A formula cell. Emits `<f>` so the spreadsheet recomputes live; `v` is an
 * optional cached result (what the formula currently evaluates to) so the value
 * shows immediately on open and survives a round-trip read. Build via
 * {@link formula}. The formula string must NOT include a leading `=`.
 */
export interface XlsxFormulaCell {
  readonly __xlsxFormula: string
  readonly v?: string | number | boolean
}

/** Build a {@link XlsxFormulaCell}. `f` is the formula body without a leading `=`. */
export function formula(f: string, cachedValue?: string | number | boolean): XlsxFormulaCell {
  return cachedValue === undefined ? { __xlsxFormula: f } : { __xlsxFormula: f, v: cachedValue }
}

function isFormulaCell(v: unknown): v is XlsxFormulaCell {
  return typeof v === 'object' && v !== null && typeof (v as { __xlsxFormula?: unknown }).__xlsxFormula === 'string'
}

/**
 * A value cell carrying a number-format code (e.g. `'#,##0.00'` for currency,
 * `'yyyy-mm-dd'` for dates). Build via {@link styled}. The format only renders
 * meaningfully on numeric values.
 */
export interface XlsxStyledCell {
  readonly __xlsxStyle: string
  readonly v: string | number | boolean | null
}

/** Build a {@link XlsxStyledCell} — a value plus an Excel number-format code. */
export function styled(value: string | number | boolean | null, numberFormat: string): XlsxStyledCell {
  return { __xlsxStyle: numberFormat, v: value }
}

function isStyledCell(v: unknown): v is XlsxStyledCell {
  return typeof v === 'object' && v !== null && typeof (v as { __xlsxStyle?: unknown }).__xlsxStyle === 'string'
}

/** A data-validation rule (dropdown) over a cell range. */
export interface XlsxValidation {
  /** Target range in A1 notation, e.g. `'B2:B100'`. */
  readonly sqref: string
  /** Inline allowed values → a `"a,b,c"` list. Mutually exclusive with `formula1`. */
  readonly values?: readonly string[]
  /** Explicit `formula1` (e.g. a range ref `Clients!$A$2:$A$999`). */
  readonly formula1?: string
}

/** One row in a sheet. A cell is a primitive value or an {@link XlsxFormulaCell}. */
export type XlsxRow = ReadonlyArray<unknown>

/** One sheet in a workbook. */
export interface XlsxSheet {
  /** Sheet tab name — Excel caps at 31 chars; we truncate with `…`. */
  readonly name: string
  /** Header row, rendered as row 1. Omit to skip the header. */
  readonly header?: readonly string[]
  /** Data rows — each is an array aligned with `header` if present. */
  readonly rows: readonly XlsxRow[]
  /**
   * Optional per-column widths in Excel character units (same scale as
   * SheetJS's `wch`). When set, emits a `<cols>` block so Excel opens
   * the file with the columns sized as specified instead of the default
   * 10-character width. Index aligned with `header` / row cells.
   *
   * Non-finite or non-positive entries are skipped (column falls back
   * to Excel's default width). A consumer typically passes `undefined`
   * for "auto" columns and a number for explicit widths.
   */
  readonly widths?: ReadonlyArray<number | undefined>
  /** Data-validation dropdowns applied to ranges on this sheet. */
  readonly validations?: readonly XlsxValidation[]
}

/**
 * Build a complete `.xlsx` byte stream from the supplied sheet data.
 * Pure — no I/O beyond the internal zip concatenation.
 */
export async function writeXlsx(
  sheets: readonly XlsxSheet[],
  options: { definedNames?: ReadonlyArray<{ readonly name: string; readonly ref: string }> } = {},
): Promise<Uint8Array> {
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

  // Number-format styles. cellXf 0 is the default (no format); each distinct
  // format code gets a numFmt (id 164+) and a cellXf that applies it.
  const numFmtCodes: string[] = []
  const styleIndexByCode = new Map<string, number>()
  const internStyle = (code: string): number => {
    const existing = styleIndexByCode.get(code)
    if (existing !== undefined) return existing
    const idx = numFmtCodes.length + 1 // cellXf index; 0 is the default xf
    numFmtCodes.push(code)
    styleIndexByCode.set(code, idx)
    return idx
  }

  // Build the worksheet XML for each sheet — coercing values per type.
  const sheetXmls: string[] = safeSheets.map((sheet) => {
    const lines: string[] = [
      XML_HEADER,
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    ]
    // `<cols>` must precede `<sheetData>` per OOXML schema. Emit one
    // `<col>` element per defined width; skip entries that are not
    // positive finite numbers so consumers can mix explicit + auto.
    if (sheet.widths && sheet.widths.length > 0) {
      const colLines: string[] = []
      for (let i = 0; i < sheet.widths.length; i++) {
        const w = sheet.widths[i]
        if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) continue
        const n = i + 1
        colLines.push(`<col min="${n}" max="${n}" width="${w}" customWidth="1"/>`)
      }
      if (colLines.length > 0) {
        lines.push('<cols>', ...colLines, '</cols>')
      }
    }
    lines.push('<sheetData>')
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
        .map((value, i) => cellXml(value, i + 1, rowNum, internString, internStyle))
        .join('')
      lines.push(`<row r="${rowNum}">${cells}</row>`)
    }
    lines.push('</sheetData>')
    if (sheet.validations && sheet.validations.length > 0) {
      lines.push(`<dataValidations count="${sheet.validations.length}">`)
      for (const dv of sheet.validations) {
        const f1 = dv.formula1 ?? `"${(dv.values ?? []).join(',')}"`
        lines.push(
          `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${escapeXmlAttr(dv.sqref)}"><formula1>${escapeXmlText(f1)}</formula1></dataValidation>`,
        )
      }
      lines.push('</dataValidations>')
    }
    lines.push('</worksheet>')
    return lines.join('')
  })

  // ── Styles (number formats) ─────────────────────────────────────

  const hasStyles = numFmtCodes.length > 0
  const stylesXml = hasStyles
    ? [
        XML_HEADER,
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        `<numFmts count="${numFmtCodes.length}">`,
        ...numFmtCodes.map((code, i) => `<numFmt numFmtId="${164 + i}" formatCode="${escapeXmlAttr(code)}"/>`),
        '</numFmts>',
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>',
        '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>',
        '<borders count="1"><border/></borders>',
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
        `<cellXfs count="${numFmtCodes.length + 1}">`,
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
        ...numFmtCodes.map(
          (_, i) => `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
        ),
        '</cellXfs>',
        '</styleSheet>',
      ].join('')
    : ''

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
    ...(hasStyles
      ? ['<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>']
      : []),
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
    ...(options.definedNames && options.definedNames.length > 0
      ? [
          '<definedNames>',
          ...options.definedNames.map(
            (d) => `<definedName name="${escapeXmlAttr(d.name)}">${escapeXmlText(d.ref)}</definedName>`,
          ),
          '</definedNames>',
        ]
      : []),
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
    ...(hasStyles
      ? [`<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`]
      : []),
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
    ...(hasStyles ? [{ path: 'xl/styles.xml', bytes: ENCODER.encode(stylesXml) }] : []),
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
  internStyle: (code: string) => number,
): string {
  const ref = `${colLetter(colIdx)}${rowNum}`
  if (isStyledCell(value)) {
    const s = internStyle(value.__xlsxStyle)
    const v = value.v
    if (v === null || v === undefined || v === '') return `<c r="${ref}" s="${s}"/>`
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${s}"><v>${v}</v></c>`
    if (typeof v === 'boolean') return `<c r="${ref}" s="${s}" t="b"><v>${v ? 1 : 0}</v></c>`
    return `<c r="${ref}" s="${s}" t="s"><v>${intern(typeof v === 'string' ? v : String(v))}</v></c>`
  }
  if (isFormulaCell(value)) {
    const f = escapeXmlText(value.__xlsxFormula)
    if (value.v === undefined) return `<c r="${ref}"><f>${f}</f></c>`
    if (typeof value.v === 'number' && Number.isFinite(value.v)) return `<c r="${ref}"><f>${f}</f><v>${value.v}</v></c>`
    if (typeof value.v === 'boolean') return `<c r="${ref}" t="b"><f>${f}</f><v>${value.v ? 1 : 0}</v></c>`
    return `<c r="${ref}" t="str"><f>${f}</f><v>${escapeXmlText(String(value.v))}</v></c>`
  }
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
