/**
 * **@noy-db/as-csv** — CSV plaintext export for noy-db.
 *
 * Decrypts records from a single collection and formats them as
 * comma-separated values suitable for spreadsheet import. RFC 4180
 * escaping (quote fields containing commas, quotes, or newlines;
 * escape embedded quotes by doubling them).
 *
 * **Authorization.** Every call is gated by the invoking keyring's
 * `assertCanExport('plaintext', …)` gate — plaintext crossings of the
 * library boundary require an explicit grant from the vault owner
 *. The package calls `vault.assertCanExport('plaintext',
 * 'csv')` before decrypting anything.
 *
 * **Scope.** One collection per call. Multi-collection + attachments
 * → use `@noy-db/as-zip`. Structured JSON → `@noy-db/as-json`.
 * Excel with dictionary-label expansion → `@noy-db/as-xlsx`.
 *
 * See [`docs/patterns/as-exports.md`](https://github.com/vLannaAi/noy-db/blob/main/docs/patterns/as-exports.md).
 *
 * @packageDocumentation
 */

import type { Vault } from '@noy-db/hub'


export interface AsCSVOptions extends AsCSVFormatOptions {
  /**
   * Collections to export. Was a single `collection`; now plural and a READ
   * concern, because hub owns the read — `vault.export(fmt, { collections })`.
   */
  readonly collections?: readonly string[]
  /** Redact before encoding. Hub applies the projection; the format never sees it. */
  readonly redact?: true | { readonly sensitivity?: string }
}

export interface AsCSVWriteOptions extends AsCSVOptions {
  /**
   * Required for Node file-write calls — consumer acknowledgement
   * that plaintext bytes will persist on disk past the current
   * process lifetime (Tier 3 risk per `docs/patterns/as-exports.md`).
   */
  readonly acknowledgeRisks: true
}

export interface AsCSVDownloadOptions extends AsCSVOptions {
  /** Filename offered to the browser. Default `'<collection>.csv'`. */
  readonly filename?: string
}

/**
 * Serialise a collection as a CSV string. Pure operation — no side
 * effects beyond the authorization check + audit ledger write.
 */
/**
 * The pure encoder. Receives records — already gated and already redacted by
 * hub — and returns CSV. It has no vault, which is what makes the export gate
 * unskippable rather than merely checked (ADR 0004).
 */
function encodeCsv(chunks: readonly ExportChunk[], options: AsCSVFormatOptions): string {
  const eol = options.eol ?? '\n'
  const records: unknown[] = chunks.flatMap((c) => c.records)
  const columns = options.columns ?? inferColumns(records)
  if (columns.length === 0) return ''
  const lines: string[] = [columns.map(escapeField).join(',')]
  for (const record of records) {
    lines.push(columns.map((c) => escapeField((record as Record<string, unknown>)[c])).join(','))
  }
  return lines.join(eol)
}

/**
 * Browser download — wraps `vault.export(asCsv())` in a `Blob` + triggers the
 * browser's download prompt. Tier 2 egress per the pattern doc.
 *
 * Requires a browser-like environment with `URL.createObjectURL` and
 * `document.createElement`. No-op in headless environments; use
 * `vault.export(asCsv())` there instead.
 */
export async function download(vault: Vault, options: AsCSVDownloadOptions = {}): Promise<void> {
  const fmt = asCsv(options)
  const csv = await vault.export(fmt, readOpts(options))
  const filename = options.filename ?? `${options.collections?.[0] ?? 'export'}.${fmt.extension}`
  const url = URL.createObjectURL(new Blob([csv], { type: fmt.mimeType }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Node file write. Still here, and not in hub, for a measured reason:
 * `check-architecture`'s `hub-portable` rule forbids Node builtins in
 * `hub/src` because hub must run in a browser, Worker, Deno and Bun. The gate,
 * the read and the redaction all moved; these three lines are the part that
 * legitimately differs per runtime.
 */
export async function write(
  vault: Vault,
  path: string,
  options: AsCSVWriteOptions,
): Promise<void> {
  if (options.acknowledgeRisks !== true) {
    throw new Error(
      'as-csv.write: acknowledgeRisks: true is required for on-disk plaintext output. ' +
      'See docs/patterns/as-exports.md - the three tiers of plaintext out.',
    )
  }
  const csv = await vault.export(asCsv(options), readOpts(options))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, csv, 'utf8')
}

/** Only the keys that are actually set — `exactOptionalPropertyTypes` is on. */
function readOpts(o: AsCSVOptions): FormatExportOptions {
  return {
    ...(o.collections ? { collections: o.collections } : {}),
    ...(o.redact !== undefined ? { redact: o.redact } : {}),
  }
}

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  const s =
    typeof value === 'string' ? value : JSON.stringify(value)
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/**
 * Derive column list from the records array, preserving first-
 * encountered-wins ordering. An explicit `options.columns` bypasses
 * this.
 */
function inferColumns(records: readonly unknown[]): string[] {
  const columns: string[] = []
  const seen = new Set<string>()
  for (const r of records) {
    if (r && typeof r === 'object') {
      for (const key of Object.keys(r)) {
        if (!seen.has(key)) {
          seen.add(key)
          columns.push(key)
        }
      }
    }
  }
  return columns
}

// ─── Reader ─────────────────────────────────────────────

// Hub-owned as of 0.7 (ADR 0004). This line replaced a local declaration that
// existed identically in six as-* packages, with nothing comparing them.
import type {
  ImportPolicy,
  ImportPlan,
  NoydbFormat,
  DecodedChunk,
  ExportChunk,
  FormatExportOptions,
} from '@noy-db/hub/as'
export type { ImportPolicy }

/** @deprecated Use `ImportPlan` from `@noy-db/hub/as` — this is now an alias. */
export type AsCSVImportPlan = ImportPlan

/**
 * Parse RFC-4180 CSV into records and build an import plan for one
 * collection. The first row is the header; subsequent rows are
 * records. Quoted fields, embedded commas, embedded `""`, and
 * CRLF line endings all round-trip through `asCsv()`.
 *
 * Cells are returned as strings unless overridden via `columnTypes`.
 * For the common case of numeric ids ("1001" → 1001), pass
 * `columnTypes: { id: 'number' }`.
 */
/**
 * The pure decoder. Bytes in, records out — no vault, no gate, no diff. Hub
 * gates, plans against the live vault, and owns `apply()`.
 */
function decodeCsv(csv: string, options: AsCSVFormatOptions): readonly DecodedChunk[] {
  const types = options.columnTypes ?? {}
  const rows = parseCSV(csv)
  if (rows.length === 0) return [{ collection: '', records: [] }]
  const header = rows[0] ?? []
  const records: Record<string, unknown>[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!
    if (row.length === 1 && row[0] === '') continue
    const record: Record<string, unknown> = {}
    for (let c = 0; c < header.length; c++) {
      const col = header[c] ?? ''
      record[col] = coerceCell(row[c] ?? '', types[col])
    }
    records.push(record)
  }
  // No collection name: CSV carries none. Hub resolves it from
  // `vault.import(fmt, csv, { collection })`.
  return [{ collection: '', records }]
}

/** Options a CSV format instance carries. Read concerns live on `vault.export`. */
export interface AsCSVFormatOptions {
  /** Line ending. Default `'\n'`. */
  readonly eol?: string
  /** Explicit column list. Omitted: inferred from the records. */
  readonly columns?: readonly string[]
  /** Per-column coercion on decode. */
  readonly columnTypes?: Readonly<Record<string, 'string' | 'number' | 'boolean'>>
}

/**
 * The CSV format — the `as-*` port instance.
 *
 * ```ts
 * const csv = await vault.export(asCsv(), { collections: ['invoices'] })
 * const plan = await vault.import(asCsv(), csv, { collection: 'invoices' })
 * await plan.apply()
 * ```
 *
 * Requires `formatsStrategy: withFormats()` on `createNoydb`.
 */
export function asCsv(options: AsCSVFormatOptions = {}): NoydbFormat<string> {
  return {
    id: 'csv',
    extension: 'csv',
    mimeType: 'text/csv;charset=utf-8',
    tier: 'plaintext',
    encode: (chunks) => encodeCsv(chunks, options),
    decode: (input) => decodeCsv(input, options),
  }
}

function coerceCell(cell: string, type?: 'string' | 'number' | 'boolean'): unknown {
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

/**
 * Minimal RFC-4180 CSV parser. Recognises:
 *   - Comma-separated fields
 *   - Quoted fields with embedded commas, newlines, and `""` escapes
 *   - Both CRLF and LF row endings
 *
 * Returns a 2D string array. The caller maps the first row to a
 * header and the rest to records.
 */
function parseCSV(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < input.length) {
    const ch = input[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\r' && input[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 2
      continue
    }
    if (ch === '\n' || ch === '\r') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    field += ch
    i++
  }

  // Final field / row.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}
