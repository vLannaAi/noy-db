/**
 * **@noy-db/as-xlsx** — Excel spreadsheet plaintext export for noy-db.
 *
 * Produces a real `.xlsx` file (Office Open XML / OOXML) from one
 * or more noy-db collections. Opens natively in Excel, Numbers,
 * LibreOffice Calc, Google Sheets, and every modern spreadsheet
 * tool.
 *
 * Zero runtime dependencies — the XLSX encoder builds the required
 * SpreadsheetML parts and assembles them with
 * `@noy-db/as-zip`'s `writeZip()` (STORE method; most xlsx
 * contents are XML text which Excel compresses at open time anyway).
 *
 * Part of the `@noy-db/as-*` portable-artefact family, plaintext
 * tier. See [`docs/patterns/as-exports.md`](https://github.com/vLannaAi/noy-db/blob/main/docs/patterns/as-exports.md).
 *
 * ## Authorisation (RFC #249)
 *
 * Every call is gated by `assertCanExport('plaintext', 'xlsx')`.
 *
 * ```ts
 * await db.grant('firm', {
 *   userId: 'accountant', role: 'viewer', passphrase: '…',
 *   exportCapability: { plaintext: ['xlsx'] },
 * })
 * ```
 *
 * @packageDocumentation
 */

import type { Vault } from '@noy-db/hub'
import { writeXlsx, type XlsxSheet } from './xlsx.js'

export { writeXlsx, colLetter, type XlsxSheet, type XlsxRow } from './xlsx.js'

/** Per-sheet options for the noy-db consumer API. */
export interface AsXlsxSheetOptions {
  /**
   * Sheet tab name. Excel caps at 31 chars; longer names are
   * truncated with `…`. Duplicates are suffixed `(2)`, `(3)`.
   */
  readonly name: string
  /** Source collection. Must be in the caller's read ACL. */
  readonly collection: string
  /**
   * Field list + order. When omitted, columns are inferred from
   * the union of keys across all records (first-record-wins order).
   */
  readonly columns?: readonly string[]
  /**
   * Optional predicate against each decrypted record. Runs after
   * decryption; doesn't reduce I/O.
   */
  readonly filter?: (record: unknown) => boolean
}

/** Single-collection convenience — passed where a sheet-list is accepted. */
export interface AsXlsxOptions {
  /** One or more sheets. At least one required. */
  readonly sheets: readonly AsXlsxSheetOptions[]
}

/** Options for `download()` — adds optional filename. */
export interface AsXlsxDownloadOptions extends AsXlsxOptions {
  /** Filename offered to the browser. Default `'export.xlsx'`. */
  readonly filename?: string
}

/** Options for `write()` — requires explicit risk acknowledgement. */
export interface AsXlsxWriteOptions extends AsXlsxOptions {
  /** Tier 3 egress — see `docs/patterns/as-exports.md`. */
  readonly acknowledgeRisks: true
}

/**
 * Convenience — single-collection shorthand. Equivalent to
 * `toBytes(vault, { sheets: [{ name: collectionName, collection: collectionName }] })`.
 */
export async function toBytesFromCollection(
  vault: Vault,
  collectionName: string,
): Promise<Uint8Array> {
  return toBytes(vault, {
    sheets: [{ name: collectionName, collection: collectionName }],
  })
}

/**
 * Build the `.xlsx` byte stream from one or more sheets. Pure
 * beyond the auth check + store reads.
 */
export async function toBytes(vault: Vault, options: AsXlsxOptions): Promise<Uint8Array> {
  vault.assertCanExport('plaintext', 'xlsx')

  if (options.sheets.length === 0) {
    throw new Error('as-xlsx: at least one sheet is required')
  }

  const materialisedSheets: XlsxSheet[] = []
  for (const sheetOpt of options.sheets) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collection = vault.collection<any>(sheetOpt.collection)
    const list = await collection.list()
    const records: Record<string, unknown>[] = []
    for (const item of list) {
      const r = item as Record<string, unknown>
      if (sheetOpt.filter && !sheetOpt.filter(r)) continue
      records.push(r)
    }
    const columns = sheetOpt.columns ?? inferColumns(records)
    materialisedSheets.push({
      name: sheetOpt.name,
      header: columns,
      rows: records.map((r) => columns.map((c) => r[c] ?? null)),
    })
  }

  return writeXlsx(materialisedSheets)
}

/**
 * Browser download. Requires a browser-like environment with
 * `URL.createObjectURL` + `document.createElement`.
 */
export async function download(vault: Vault, options: AsXlsxDownloadOptions): Promise<void> {
  const bytes = await toBytes(vault, options)
  const filename = options.filename ?? 'export.xlsx'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = new Blob([bytes as any], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Node file-write. Requires `acknowledgeRisks: true` because the
 * plaintext xlsx persists past the process (Tier 3 egress).
 */
export async function write(
  vault: Vault,
  path: string,
  options: AsXlsxWriteOptions,
): Promise<void> {
  if (options.acknowledgeRisks !== true) {
    throw new Error(
      'as-xlsx.write: acknowledgeRisks: true is required for on-disk plaintext output. ' +
        'This call creates a persistent plaintext xlsx outside noy-db\'s encrypted storage — ' +
        'see docs/patterns/as-exports.md §"The three tiers of \\"plaintext out\\""',
    )
  }
  const bytes = await toBytes(vault, options)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, bytes)
}

// ── internals ─────────────────────────────────────────────────────

function inferColumns(records: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of records) {
    for (const key of Object.keys(r)) {
      if (!seen.has(key)) {
        seen.add(key)
        out.push(key)
      }
    }
  }
  return out
}
