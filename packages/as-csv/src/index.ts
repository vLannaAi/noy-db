/**
 * **@noy-db/as-csv** — CSV plaintext export for noy-db.
 *
 * Decrypts records from a single collection and formats them as
 * comma-separated values suitable for spreadsheet import. RFC 4180
 * escaping (quote fields containing commas, quotes, or newlines;
 * escape embedded quotes by doubling them).
 *
 * **Authorization.** Every call is gated by the invoking keyring's
 * `canExportPlaintext` capability — plaintext crossings of the
 * library boundary require an explicit grant from the vault owner
 * (RFC #249). The package calls `vault.assertCanExport('plaintext',
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

export interface AsCSVOptions {
  /**
   * Collection to export. Must be in the caller's read ACL; otherwise
   * the resulting CSV will be empty (ACL-scoping applies at the
   * `exportStream` layer).
   */
  readonly collection: string

  /**
   * Explicit column list. When omitted, columns are inferred from
   * the union of keys across all records, in first-record-wins
   * order. Specify explicitly for deterministic exports or when the
   * source data has sparse fields.
   */
  readonly columns?: readonly string[]

  /**
   * Row separator. Default `'\n'` (LF). Use `'\r\n'` for Windows-
   * friendly output (Excel prefers CRLF but accepts LF).
   */
  readonly eol?: '\n' | '\r\n'
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
export async function toString(vault: Vault, options: AsCSVOptions): Promise<string> {
  vault.assertCanExport('plaintext', 'csv')

  const eol = options.eol ?? '\n'
  const collection = options.collection

  // Pull the one collection via exportStream in collection granularity.
  const records: unknown[] = []
  for await (const chunk of vault.exportStream({ granularity: 'collection' })) {
    if (chunk.collection === collection) {
      records.push(...chunk.records)
      break
    }
  }

  // Determine columns.
  const columns = options.columns ?? inferColumns(records)
  if (columns.length === 0) {
    // Empty collection or no accessible records — emit header-only csv.
    return ''
  }

  // Build header + rows
  const lines: string[] = [columns.map(escapeField).join(',')]
  for (const record of records) {
    const row = columns.map(c => escapeField((record as Record<string, unknown>)[c]))
    lines.push(row.join(','))
  }
  return lines.join(eol)
}

/**
 * Browser download — wraps `toString()` in a `Blob` + triggers the
 * browser's download prompt. Tier 2 egress per the pattern doc.
 *
 * Requires a browser-like environment with `URL.createObjectURL` and
 * `document.createElement`. No-op in headless environments; use
 * `toString()` there instead.
 */
export async function download(vault: Vault, options: AsCSVDownloadOptions): Promise<void> {
  const csv = await toString(vault, options)
  const filename = options.filename ?? `${options.collection}.csv`
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Node file-write — persists the CSV to the filesystem. Requires
 * explicit `acknowledgeRisks: true` because the plaintext file
 * outlives the current process (Tier 3 egress).
 */
export async function write(
  vault: Vault,
  path: string,
  options: AsCSVWriteOptions,
): Promise<void> {
  if (options.acknowledgeRisks !== true) {
    throw new Error(
      'as-csv.write: acknowledgeRisks: true is required for on-disk plaintext output. ' +
      'This call creates a persistent plaintext copy of your data outside noy-db\'s ' +
      'encrypted storage — see docs/patterns/as-exports.md §"The three tiers of \\"plaintext out\\""',
    )
  }
  const csv = await toString(vault, options)
  // Defer the node:fs import so this package remains browser-safe.
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, csv, 'utf-8')
}

// ── CSV formatting internals ───────────────────────────────────────────

/**
 * RFC 4180 escaping: wrap a field in double quotes if it contains
 * comma, double quote, CR, or LF. Embedded double quotes become `""`.
 * Other values stringify naturally.
 */
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
