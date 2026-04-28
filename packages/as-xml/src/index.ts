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
}

export interface AsXMLDownloadOptions extends AsXMLOptions {
  /** Filename offered to the browser. Default `'<collection>.xml'`. */
  readonly filename?: string
}

export interface AsXMLWriteOptions extends AsXMLOptions {
  /** Required for Node file-write — Tier 3 risk gate. */
  readonly acknowledgeRisks: true
}

export async function toString(vault: Vault, options: AsXMLOptions): Promise<string> {
  vault.assertCanExport('plaintext', 'xml')

  const records: unknown[] = []
  for await (const chunk of vault.exportStream({ granularity: 'collection' })) {
    if (chunk.collection === options.collection) {
      records.push(...chunk.records)
      break
    }
  }

  const rootName = options.rootElement ?? 'Records'
  const recordName = options.recordElement ?? pascalSingular(options.collection)
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

export async function download(vault: Vault, options: AsXMLDownloadOptions): Promise<void> {
  const xml = await toString(vault, options)
  const filename = options.filename ?? `${options.collection}.xml`
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function write(vault: Vault, path: string, options: AsXMLWriteOptions): Promise<void> {
  if (options.acknowledgeRisks !== true) {
    throw new Error(
      'as-xml.write: acknowledgeRisks: true is required for on-disk plaintext output. ' +
      'See docs/patterns/as-exports.md §"The three tiers of \\"plaintext out\\""',
    )
  }
  const xml = await toString(vault, options)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, xml, 'utf-8')
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

// ─── Reader (#318 / #302 phase 2) ──────────────────────────────────────

import { diffVault, type VaultDiff } from '@noy-db/hub'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

export type ImportPolicy = 'merge' | 'replace' | 'insert-only'

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

export interface AsXMLImportPlan {
  readonly plan: VaultDiff
  readonly policy: ImportPolicy
  apply(): Promise<void>
}

/**
 * Parse XML into records and build an import plan. Inverts what
 * `toString()` writes: root → recordElement[] → field elements with
 * text content. Field values default to strings; pass `fieldTypes` to
 * coerce numbers / booleans on read.
 *
 * Throws on malformed XML — fast-xml-parser is invoked in strict mode
 * so unbalanced tags or invalid character sequences fail fast.
 *
 * Capability: `assertCanImport('plaintext', 'xml')` (#308).
 * Atomicity: `apply()` runs inside `vault.noydb.transaction()` (#309).
 */
export async function fromString(
  vault: Vault,
  xml: string,
  options: AsXMLImportOptions,
): Promise<AsXMLImportPlan> {
  vault.assertCanImport('plaintext', 'xml')

  const policy: ImportPolicy = options.policy ?? 'merge'
  const idKey = options.idKey ?? 'id'
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
      `as-xml.fromString: input is not valid XML (${err.code} at line ${err.line}: ${err.msg})`,
    )
  }

  let parsed: unknown
  try {
    parsed = parser.parse(xml)
  } catch (err) {
    throw new Error(`as-xml.fromString: input is not valid XML (${(err as Error).message})`)
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('as-xml.fromString: parser produced a non-object root')
  }

  // Drill into the root. fast-xml-parser surfaces `<Root><Item/>...</Root>` as
  // `{ Root: { Item: [...] | {...} } }`. Strip namespace prefixes from element
  // names by splitting on `:` so the writer's `<ns:Records>` round-trips.
  const root = stripNamespacePrefixes(parsed as Record<string, unknown>)
  const rootKeys = Object.keys(root)
  if (rootKeys.length === 0) {
    return emptyPlan(vault, options.collection, policy, idKey)
  }
  // Pick first non-`?xml` root child — fast-xml-parser ignores the
  // declaration by default but be defensive.
  const rootName = rootKeys.find((k) => !k.startsWith('?')) ?? rootKeys[0]!
  const rootBody = stripIfObject(root[rootName])

  if (rootBody === null) {
    return emptyPlan(vault, options.collection, policy, idKey)
  }

  const recordElName = options.recordElement
    ? stripPrefix(options.recordElement)
    : pickRecordElementName(rootBody)

  if (recordElName === null) {
    return emptyPlan(vault, options.collection, policy, idKey)
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

  const plan = await diffVault(vault, { [options.collection]: records }, {
    collections: [options.collection],
    idKey,
  })

  return {
    plan,
    policy,
    async apply(): Promise<void> {
      // Routes through txStrategy seam — throws clearly when
      // withTransactions() isn't opted in. Atomicity rolls back any
      // partial writes if a put fails mid-batch.
      await vault.noydb.transaction((tx) => {
        const txVault = tx.vault(vault.name)
        for (const entry of plan.added) {
          txVault.collection(entry.collection).put(entry.id, entry.record)
        }
        if (policy !== 'insert-only') {
          for (const entry of plan.modified) {
            txVault.collection(entry.collection).put(entry.id, entry.record)
          }
        }
        if (policy === 'replace') {
          for (const entry of plan.deleted) {
            txVault.collection(entry.collection).delete(entry.id)
          }
        }
      })
    },
  }
}

async function emptyPlan(
  vault: Vault,
  collection: string,
  policy: ImportPolicy,
  idKey: string,
): Promise<AsXMLImportPlan> {
  const plan = await diffVault(vault, { [collection]: [] }, { collections: [collection], idKey })
  return { plan, policy, async apply() { /* nothing to do */ } }
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
