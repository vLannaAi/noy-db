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
