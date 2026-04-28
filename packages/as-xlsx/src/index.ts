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
import { readXlsx } from './read.js'

export { writeXlsx, colLetter, type XlsxSheet, type XlsxRow } from './xlsx.js'
export { readXlsx, type ReadXlsxResult, type ReadXlsxSheet, type ReadXlsxRow } from './read.js'

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

// ── Reader (#319 / #302 phase 2) ──────────────────────────────────────

import { diffVault, type VaultDiff } from '@noy-db/hub'

export type ImportPolicy = 'merge' | 'replace' | 'insert-only'

export interface AsXlsxImportOptions {
  /** Target collection. xlsx has no native collection grouping. */
  readonly collection: string
  /**
   * Sheet name to read. Defaults to the first sheet in the workbook.
   */
  readonly sheet?: string
  /**
   * 1-based header row index. Default `1` (first row).
   */
  readonly headerRow?: number
  /**
   * Optional field type hints. xlsx cells already have a type
   * (number, boolean, shared-string), so this is for the few cases
   * where the writer's emission rules don't preserve intent —
   * notably ISO-date strings the writer routed through the shared-
   * string path. `'date'` parses the value with `new Date()` and
   * keeps the result as an ISO-8601 string for stable round-tripping.
   */
  readonly fieldTypes?: Record<string, 'string' | 'number' | 'boolean' | 'date'>
  /** Field carrying the record id. Default `'id'`. */
  readonly idKey?: string
  /** Reconciliation policy. Default `'merge'`. */
  readonly policy?: ImportPolicy
}

export interface AsXlsxImportPlan {
  readonly plan: VaultDiff
  readonly policy: ImportPolicy
  apply(): Promise<void>
}

/**
 * Build an import plan from an `.xlsx` byte stream. Inverts what
 * `toBytes()` writes — the first row is the header, subsequent rows
 * are records keyed by the column letters in the header row.
 *
 * Capability: `assertCanImport('plaintext', 'xlsx')` (#308).
 * Atomicity: `apply()` runs inside `vault.noydb.transaction()` (#309).
 *
 * **Not supported (matches the writer scope):**
 * - Cell styles / number formats / date format codes
 * - Formulas, merged cells, frozen panes
 * - Inline strings → handled defensively (since some upstream tools
 *   emit them) but the writer never produces them
 * - Excel date serials → not auto-detected; pass `fieldTypes: { ts:
 *   'date' }` to coerce a numeric serial to ISO. Date round-trip via
 *   the writer (which emits ISO strings) works without a hint.
 *
 * **Dict-label inversion** (writer expands enum dict keys via i18nText
 * to human labels) — deferred follow-up; the reader returns the human
 * label as-is. Pair with a manual mapping pass at the consumer if
 * round-trip through dicts is required.
 */
export async function fromBytes(
  vault: Vault,
  bytes: Uint8Array,
  options: AsXlsxImportOptions,
): Promise<AsXlsxImportPlan> {
  vault.assertCanImport('plaintext', 'xlsx')

  const policy: ImportPolicy = options.policy ?? 'merge'
  const idKey = options.idKey ?? 'id'
  const types = options.fieldTypes ?? {}
  const headerRowIdx = (options.headerRow ?? 1) - 1
  if (headerRowIdx < 0) {
    throw new Error('as-xlsx.fromBytes: headerRow must be 1-based and >= 1')
  }

  const decoded = await readXlsx(bytes)
  if (decoded.sheets.length === 0) {
    return emptyXlsxPlan(vault, options.collection, policy, idKey)
  }
  const sheet = options.sheet === undefined
    ? decoded.sheets[0]!
    : decoded.sheets.find((s) => s.name === options.sheet)
  if (sheet === undefined) {
    throw new Error(
      `as-xlsx.fromBytes: workbook has no sheet named "${options.sheet}". ` +
        `Available: ${decoded.sheets.map((s) => `"${s.name}"`).join(', ')}`,
    )
  }

  const allRows = sheet.rows
  if (allRows.length <= headerRowIdx) {
    return emptyXlsxPlan(vault, options.collection, policy, idKey)
  }
  const headerRow = allRows[headerRowIdx]!
  // Map column letter → field name. Only columns that have a
  // non-empty header cell contribute fields; blank columns are
  // ignored on read so a half-populated header doesn't synthesise
  // numeric `__EMPTY` keys the way some xlsx libs do.
  const colToField = new Map<string, string>()
  for (const [col, value] of Object.entries(headerRow)) {
    const fieldName = headerCellToField(value)
    if (fieldName === '') continue
    colToField.set(col, fieldName)
  }

  const records: Record<string, unknown>[] = []
  for (let i = headerRowIdx + 1; i < allRows.length; i++) {
    const row = allRows[i]!
    const record: Record<string, unknown> = {}
    let hasAny = false
    for (const [col, value] of Object.entries(row)) {
      const field = colToField.get(col)
      if (field === undefined) continue
      const coerced = coerceXlsxCell(value, types[field])
      if (coerced !== undefined) {
        record[field] = coerced
        hasAny = true
      }
    }
    if (hasAny) records.push(record)
  }

  const plan = await diffVault(vault, { [options.collection]: records }, {
    collections: [options.collection],
    idKey,
  })

  return {
    plan,
    policy,
    async apply(): Promise<void> {
      // Routes through the txStrategy seam (#309) — clear error when
      // withTransactions() isn't opted in.
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

async function emptyXlsxPlan(
  vault: Vault,
  collection: string,
  policy: ImportPolicy,
  idKey: string,
): Promise<AsXlsxImportPlan> {
  const plan = await diffVault(vault, { [collection]: [] }, { collections: [collection], idKey })
  return { plan, policy, async apply() { /* nothing to do */ } }
}

function headerCellToField(value: unknown): string {
  // Header cells should be strings; defensively coerce numbers/booleans
  // and reject everything else (objects, undefined). Empty string =
  // "this column has no header → ignore".
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function coerceXlsxCell(
  value: unknown,
  type?: 'string' | 'number' | 'boolean' | 'date',
): unknown {
  if (value === undefined || value === null) return undefined
  if (type === undefined) return value
  if (type === 'string') {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return undefined
  }
  if (type === 'number') {
    if (typeof value === 'number') return value
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 1) return true
    if (value === 'false' || value === 0) return false
    return undefined
  }
  if (type === 'date') {
    // Excel date serial: days since 1900-01-01 with the historical
    // 1900-leap-year quirk. Numbers are converted; strings parsed
    // with `new Date()` and re-emitted as ISO so round-trips are
    // stable. Returning a string keeps the JSON envelope canonical.
    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = excelSerialToMs(value)
      const d = new Date(ms)
      return d.toISOString()
    }
    if (typeof value === 'string') {
      const d = new Date(value)
      if (!Number.isNaN(d.getTime())) return d.toISOString()
    }
    return undefined
  }
  return value
}

/**
 * Convert an Excel-style date serial to a JS millisecond timestamp.
 * Excel's "1900 system" treats day 1 as 1900-01-01 and includes the
 * non-existent 1900-02-29, so the offset between Excel serial and
 * Unix epoch days is 25569 for any date past 1900-03-01.
 *
 * Pre-1900-03 dates (serial ≤ 60) are uncommon in noy-db's domains
 * and we don't try to compensate for the leap-year bug there — they
 * round-trip with one-day skew, same as Excel itself.
 */
function excelSerialToMs(serial: number): number {
  const EPOCH_OFFSET_DAYS = 25569
  const MS_PER_DAY = 86400_000
  return Math.round((serial - EPOCH_OFFSET_DAYS) * MS_PER_DAY)
}
