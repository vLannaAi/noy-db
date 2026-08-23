/**
 * **@noy-db/as-xml** — XML plaintext export for noy-db.
 *
 * Hand-rolled XML emitter — zero dependencies, ~100 LoC. Escapes the
 * five predefined XML entities (`<`, `>`, `&`, `'`, `"`) and numeric
 * control characters. Supports custom root/record element names,
 * namespaces, pretty-printing, and XML declarations.
 *
 * **Scope.** Single collection per call (mirroring as-csv's shape).
 * Multi-collection XML documents are best produced by the consumer
 * composing multiple `toString()` calls into a wrapping element.
 *
 * ### When to use
 *
 * - Legacy systems requiring XML input (accounting software, SOAP).
 * - Banking batch imports (ISO 20022, CAMT/PAIN files consumers wrap).
 * - Excel `.xml` SpreadsheetML 2003 legacy format (wrap in a
 *   Workbook template).
 *
 * @packageDocumentation
 */

import type {
  ExportChunk,
  NoydbFormat,
  DecodedChunk,
  FormatExportOptions,
} from '@noy-db/hub/as'
import type { Vault } from '@noy-db/hub'

export interface AsXMLOptions {
  /** Collection to export. */
  readonly collection: string
  /** Root element name. Default `'Records'`. */
  readonly rootElement?: string
  /** Per-record element name. Default pascal-cased singular of collection. */
  readonly recordElement?: string
  /** Explicit field list — defaults to inferred columns. */
  readonly fields?: readonly string[]
  /** Include `<?xml version="1.0" encoding="UTF-8"?>` declaration. Default `true`. */
  readonly xmlDeclaration?: boolean
  /** Pretty-print with 2-space indentation. Default `true`. */
  readonly pretty?: boolean
  /** Optional XML namespace on the root element. */
  readonly namespace?: string
  /** Optional namespace prefix. Used together with `namespace`. */
  readonly namespacePrefix?: string
  /**
   * Apply the hub's `applyListProjection` read-projection before
   * serialising records. `true` redacts only `classifiedFields` (mask /
   * omit / rider, per the field's preset). The object form additionally
   * redacts fields carrying a plain `fieldMeta` `sensitivity: 'pii' |
   * 'secret'` tag, per `sensitivity: 'omit' | 'mask'`.
   *
   * Caveat: `describe()` reflects the declarations of *this session's*
   * collection instance — redaction only takes effect when the
   * collection was opened (this call or earlier in the session) with
   * its `classifiedFields` / `fieldMeta` options. This is presentation-
   * layer redaction; it never affects what's on disk. Sealed handles
   * are unaffected either way — they always serialize as `'[sealed]'`,
   * so ciphertext never leaks regardless of this option. Rider companion
   * fields (e.g. `pan_last4`) remain visible as their own elements —
   * they are safe write-time projections.
   */
  readonly redact?: boolean | { readonly sensitivity: 'omit' | 'mask' }
}

export interface AsXMLDownloadOptions extends AsXMLOptions {
  /** Filename offered to the browser. Default `'<collection>.xml'`. */
  readonly filename?: string
}

export interface AsXMLWriteOptions extends AsXMLOptions {
  /** Required for Node file-write — Tier 3 risk gate. */
  readonly acknowledgeRisks: true
}

/**
 * The pure encoder — records in, XML out. Already gated and already redacted
 * by hub; it has no vault (ADR 0004).
 */
function encodeXml(chunks: readonly ExportChunk[], options: AsXMLFormatOptions): string {
  const records: unknown[] = chunks.flatMap((c) => c.records)

  const rootName = options.rootElement ?? 'Records'
  // The chunk carries its collection name, so the element default survives the
  // inversion without the format needing to be told which collection it got.
  const recordName = options.recordElement ?? pascalSingular(chunks[0]?.collection ?? 'Record')
  const fields = options.fields ?? inferFields(records)
  const pretty = options.pretty !== false
  const declaration = options.xmlDeclaration !== false
  const indent = pretty ? '  ' : ''
  const nl = pretty ? '\n' : ''

  const parts: string[] = []
  if (declaration) parts.push('<?xml version="1.0" encoding="UTF-8"?>' + nl)

  const nsAttr = options.namespace
    ? options.namespacePrefix
      ? ` xmlns:${options.namespacePrefix}="${escapeAttr(options.namespace)}"`
      : ` xmlns="${escapeAttr(options.namespace)}"`
    : ''
  const rootTag = options.namespacePrefix
    ? `${options.namespacePrefix}:${rootName}`
    : rootName
  const recordTag = options.namespacePrefix
    ? `${options.namespacePrefix}:${recordName}`
    : recordName

  parts.push(`<${rootTag}${nsAttr}>`)
  for (const record of records) {
    parts.push(nl + indent + `<${recordTag}>`)
    for (const field of fields) {
      const value = (record as Record<string, unknown>)[field]
      if (value === undefined) continue
      const tag = escapeElementName(field)
      parts.push(nl + indent + indent + `<${tag}>${escapeText(serializeValue(value))}</${tag}>`)
    }
    parts.push(nl + indent + `</${recordTag}>`)
  }
  parts.push(nl + `</${rootTag}>`)
  return parts.join('')
}

/** Options an XML format instance carries. Read concerns live on `vault.export`. */
export interface AsXMLFormatOptions {
  readonly rootElement?: string
  readonly recordElement?: string
  readonly fields?: readonly string[]
  readonly xmlDeclaration?: boolean
  readonly pretty?: boolean
  readonly namespace?: string
  readonly namespacePrefix?: string
  /** Per-field coercion on decode. */
  readonly fieldTypes?: Readonly<Record<string, 'string' | 'number' | 'boolean'>>
}

/**
 * The XML format — the `as-*` port instance.
 *
 * ```ts
 * const xml = await vault.export(asXml(), { collections: ['invoices'] })
 * const plan = await vault.import(asXml(), xml, { collection: 'invoices' })
 * ```
 */
export function asXml(options: AsXMLFormatOptions = {}): NoydbFormat<string> {
  return {
    id: 'xml',
    extension: 'xml',
    mimeType: 'application/xml;charset=utf-8',
    tier: 'plaintext',
    encode: (chunks) => encodeXml(chunks, options),
    decode: (input) => decodeXml(input, options),
  }
}

/** Only the keys actually set — `exactOptionalPropertyTypes` is on. */
function readOpts(o: AsXMLOptions): FormatExportOptions {
  return {
    ...(o.collection ? { collections: [o.collection] } : {}),
    ...(o.redact !== undefined && o.redact !== false
      ? { redact: o.redact === true ? true : { sensitivity: o.redact.sensitivity } }
      : {}),
  }
}

/** Browser download. Hub gates, reads and redacts; this wraps the bytes. */
export async function download(vault: Vault, options: AsXMLDownloadOptions): Promise<void> {
  const fmt = asXml(options)
  const xml = await vault.export(fmt, readOpts(options))
  const url = URL.createObjectURL(new Blob([xml], { type: fmt.mimeType }))
  const a = document.createElement('a')
  a.href = url
  a.download = options.filename ?? `${options.collection}.${fmt.extension}`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Node file write. Not in hub because `hub-portable` forbids Node builtins
 * there. The gate, the read and the redaction all moved.
 */
export async function write(vault: Vault, path: string, options: AsXMLWriteOptions): Promise<void> {
  if (options.acknowledgeRisks !== true) {
    throw new Error('as-xml.write: acknowledgeRisks: true is required for on-disk plaintext output.')
  }
  const xml = await vault.export(asXml(options), readOpts(options))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, xml, 'utf8')
}


// ─── XML formatting internals ───────────────────────────────────────────

const XML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

function escapeText(s: string): string {
  let out = s.replace(/[&<>]/g, ch => XML_ENTITIES[ch]!)
  // Strip XML-invalid control characters (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F).
  // Done as a char-by-char scan to keep the regex free of control-character literals
  // (which eslint's no-control-regex flags).
  let cleaned = ''
  for (let i = 0; i < out.length; i++) {
    const code = out.charCodeAt(i)
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0B ||
      code === 0x0C ||
      (code >= 0x0E && code <= 0x1F)
    ) continue
    cleaned += out[i]
  }
  out = cleaned
  return out
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, ch => XML_ENTITIES[ch]!)
}

function escapeElementName(name: string): string {
  // XML element names must start with a letter/underscore and contain only
  // letters, digits, hyphens, underscores, dots. Replace everything else.
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_')
  return /^[A-Za-z_]/.test(safe) ? safe : `_${safe}`
}

function serializeValue(value: unknown): string {
  if (value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}

function inferFields(records: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const fields: string[] = []
  for (const r of records) {
    if (r && typeof r === 'object') {
      for (const k of Object.keys(r)) {
        if (k === '_v' || k === '_ts' || k === '_by' || k === '_iv' || k === '_data' || k === '_noydb') continue
        if (!seen.has(k)) {
          seen.add(k)
          fields.push(k)
        }
      }
    }
  }
  return fields
}

function pascalSingular(collection: string): string {
  const singular = collection.endsWith('s') ? collection.slice(0, -1) : collection
  return singular.charAt(0).toUpperCase() + singular.slice(1)
}

// ─── Reader ──────────────────────────────────────

import { XMLParser, XMLValidator } from 'fast-xml-parser'

// Hub-owned as of 0.7 (ADR 0004). This line replaced a local declaration that
// existed identically in six as-* packages, with nothing comparing them.
import type { ImportPolicy, ImportPlan } from '@noy-db/hub/as'
export type { ImportPolicy }

export interface AsXMLImportOptions {
  /** Target collection. Required — XML has no native collection grouping. */
  readonly collection: string
  /**
   * Optional explicit record-element name. When omitted, the reader
   * picks the first repeated child of the root. (Writer's default is
   * `pascalSingular(collection)` — pass that here for symmetric
   * round-tripping if you wrote with a custom `recordElement`.)
   */
  readonly recordElement?: string
  /**
   * Optional field type hints. Cells are returned as strings unless
   * overridden. Same shape as `as-csv.fromString`'s `columnTypes`.
   */
  readonly fieldTypes?: Record<string, 'string' | 'number' | 'boolean'>
  /** Field carrying the record id. Default `'id'`. */
  readonly idKey?: string
  /** Reconciliation policy. Default `'merge'`. */
  readonly policy?: ImportPolicy
}

export type AsXMLImportPlan = ImportPlan

/**
 * Parse XML into records and build an import plan. Inverts what
 * `toString()` writes: root → recordElement[] → field elements with
 * text content. Field values default to strings; pass `fieldTypes` to
 * coerce numbers / booleans on read.
 *
 * Throws on malformed XML — fast-xml-parser is invoked in strict mode
 * so unbalanced tags or invalid character sequences fail fast.
 *
 * Capability: `assertCanImport('plaintext', 'xml')`.
 * Atomicity: `apply()` runs inside `vault.noydb.transaction()`.
 */
/**
 * The pure decoder — XML in, records out. No vault, no gate, no diff: hub
 * gates, plans against the live vault and owns `apply()`.
 */
function decodeXml(xml: string, options: AsXMLFormatOptions): readonly DecodedChunk[] {
  const types = options.fieldTypes ?? {}

  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,        // keep raw strings — we coerce ourselves
    parseAttributeValue: false,
    trimValues: true,
    // Only force-as-array the record element so a single-record XML still
    // produces an array. We'll narrow this when we discover the element name.
  })

  // Strict validation first — fast-xml-parser is permissive by default
  // (silently accepts unbalanced tags). XMLValidator returns true on
  // success or an error object describing the position of the failure.
  const validation = XMLValidator.validate(xml)
  if (validation !== true) {
    const err = validation.err
    throw new Error(
      `as-xml decode: input is not valid XML (${err.code} at line ${err.line}: ${err.msg})`,
    )
  }

  let parsed: unknown
  try {
    parsed = parser.parse(xml)
  } catch (err) {
    throw new Error(`as-xml decode: input is not valid XML (${(err as Error).message})`)
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('as-xml decode: parser produced a non-object root')
  }

  // Drill into the root. fast-xml-parser surfaces `<Root><Item/>...</Root>` as
  // `{ Root: { Item: [...] | {...} } }`. Strip namespace prefixes from element
  // names by splitting on `:` so the writer's `<ns:Records>` round-trips.
  const root = stripNamespacePrefixes(parsed as Record<string, unknown>)
  const rootKeys = Object.keys(root)
  if (rootKeys.length === 0) {
    return [{ collection: '', records: [] }]
  }
  // Pick first non-`?xml` root child — fast-xml-parser ignores the
  // declaration by default but be defensive.
  const rootName = rootKeys.find((k) => !k.startsWith('?')) ?? rootKeys[0]!
  const rootBody = stripIfObject(root[rootName])

  if (rootBody === null) {
    return [{ collection: '', records: [] }]
  }

  const recordElName = options.recordElement
    ? stripPrefix(options.recordElement)
    : pickRecordElementName(rootBody)

  if (recordElName === null) {
    return [{ collection: '', records: [] }]
  }

  const recordsRaw = rootBody[recordElName]
  const recordsArr = recordsRaw === undefined ? []
    : Array.isArray(recordsRaw) ? recordsRaw : [recordsRaw]

  const records: Record<string, unknown>[] = []
  for (const r of recordsArr) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) continue
    const flat = stripNamespacePrefixes(r as Record<string, unknown>)
    const record: Record<string, unknown> = {}
    for (const [field, raw] of Object.entries(flat)) {
      // The XML parser exposes text-only elements as primitives or
      // empty objects (when the element is `<tag/>`). Normalize.
      const text = textValue(raw)
      record[field] = coerce(text, types[field])
    }
    records.push(record)
  }

  // XML carries no collection name; hub resolves it from
  // `vault.import(fmt, xml, { collection })`.
  return [{ collection: '', records }]
}



function stripPrefix(name: string): string {
  const idx = name.indexOf(':')
  return idx === -1 ? name : name.slice(idx + 1)
}

function stripNamespacePrefixes(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[stripPrefix(k)] = v
  }
  return out
}

function stripIfObject(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  return stripNamespacePrefixes(v as Record<string, unknown>)
}

/**
 * Pick the first non-attribute key in `body` — that's the per-record
 * element. Skips namespace-attribute keys like `@_xmlns:foo` (defensive
 * even though `ignoreAttributes: true` should drop them).
 */
function pickRecordElementName(body: Record<string, unknown>): string | null {
  for (const k of Object.keys(body)) {
    if (k.startsWith('@_') || k.startsWith('?')) continue
    return k
  }
  return null
}

/**
 * Extract the text content from a parsed-element value. The parser
 * surfaces `<a>x</a>` as the string `"x"`, `<a/>` as the empty string,
 * and `<a><b>...</b></a>` as an object — we treat the last case as
 * "not a leaf" and stringify whatever's there.
 */
function textValue(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return ''
}

function coerce(cell: string, type?: 'string' | 'number' | 'boolean'): unknown {
  if (type === 'number') {
    if (cell === '') return undefined
    const n = Number(cell)
    return Number.isFinite(n) ? n : cell
  }
  if (type === 'boolean') {
    if (cell === 'true') return true
    if (cell === 'false') return false
    return cell
  }
  return cell
}
