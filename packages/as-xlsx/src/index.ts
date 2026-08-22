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
 * ## Authorisation
 *
 * Every call is gated by `assertCanExport('plaintext', 'xlsx')`.
 *
 * ```ts
 * await db.grant('firm', {
 *   userId: 'accountant', role: 'viewer', secret: '…',
 *   exportCapability: { plaintext: ['xlsx'] },
 * })
 * ```
 *
 * @packageDocumentation
 */

import { type Vault, type DictEntry } from '@noy-db/hub'
import { applyListProjection } from '@noy-db/hub/introspection'
import { writeXlsx, colLetter, formula, styled, type XlsxSheet, type XlsxValidation } from './xlsx.js'
import { readXlsx } from './read.js'

export { writeXlsx, colLetter, formula, styled, type XlsxSheet, type XlsxRow, type XlsxFormulaCell, type XlsxStyledCell, type XlsxValidation } from './xlsx.js'
export { readXlsx, type ReadXlsxResult, type ReadXlsxSheet, type ReadXlsxRow } from './read.js'
export { inferSchema, zodSourceFor, type InferredSchema, type InferredCollection, type InferredField, type InferredType } from './infer.js'

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
  /**
   * Optional per-column character widths (Excel `wch` units). When set,
   * the emitted sheet opens with the requested column widths instead of
   * Excel's default 10-character fallback. Index aligned with
   * `columns` / inferred-column order.
   *
   * Non-finite or non-positive entries are skipped so consumers can
   * mix explicit + auto (pass `undefined` for "auto").
   *
   * Length is NOT validated against `columns.length` — extra entries
   * are harmless (no `<col>` is emitted past the column count) and a
   * short array leaves trailing columns at Excel's default. This
   * mirrors `XlsxSheet.widths`, which it threads through.
   */
  readonly widths?: ReadonlyArray<number | undefined>
  /**
   * Smart mode only: per-field Excel number-format codes (e.g.
   * `{ amount: '#,##0.00' }` for currency). The value is coerced to a number so
   * the format renders. Money has no introspection signal, so currency
   * formatting is opt-in here.
   */
  readonly numberFormats?: Record<string, string>
  /**
   * Smart mode only: per-field explicit dropdown value lists. Overrides the
   * auto-detected enum/ref dropdown for that field.
   */
  readonly dropdowns?: Record<string, readonly string[]>
  /**
   * Smart mode only: fields whose stored value is a multi-locale i18n map
   * (`{ en: '…', th: '…' }`). Each becomes per-locale columns plus a display
   * column resolved **live by the global LANG cell** (change LANG → every label
   * re-renders). Read raw, so open the export vault without an active locale.
   */
  readonly i18nFields?: readonly string[]
  /**
   * Smart mode only: map a dict-backed (code) field to its dictionary name, e.g.
   * `{ status: 'status' }`. Emits a hidden `_Lookups_<dict>` sheet (code +
   * per-locale labels) and a `<field>__label` display column resolved by the
   * global LANG cell via `VLOOKUP(code, …, MATCH(LANG, …))`.
   */
  readonly dictFields?: Record<string, string>
  /**
   * Multi-vault export only: pull FK-referenced fields from a supporting vault
   * into this sheet as extra columns. Each entry resolves `localField` on the
   * primary record against the `keyField` of another vault's collection (matched
   * by `from.label`/`from.collection`), and emits the `pick` field value as
   * `column`. Appended AFTER the declared `columns` in declaration order.
   * Unresolved FK (row not in the supporting-vault index) → empty cell.
   * Ignored by single-vault `toBytes`.
   */
  readonly denormalize?: readonly MultiVaultDenormColumn[]
}

/**
 * One denormalized column in a multi-vault export: pulls a field from a
 * supporting vault into the primary sheet via an in-memory join.
 *
 * @example
 * ```ts
 * {
 *   column: 'entityName',   // new column header in the primary sheet
 *   localField: 'entityId', // FK field on the primary record
 *   from: { label: 'directory', collection: 'entities', keyField: 'id', pick: 'name' },
 * }
 * ```
 */
export interface MultiVaultDenormColumn {
  /** Header of the new column to append to the primary sheet. */
  readonly column: string
  /** Field on the primary record whose value is the FK. */
  readonly localField: string
  readonly from: {
    /** Label of the supporting vault entry (matches `MultiVaultXlsxEntry.label`). */
    readonly label: string
    /** Collection in the supporting vault. */
    readonly collection: string
    /** Field in the supporting record that is the join key (usually `'id'`). */
    readonly keyField: string
    /** Field in the supporting record to copy as the denorm value. */
    readonly pick: string
  }
}

/** One aggregate column in a smart-mode summary sheet (#414 P3). */
export interface AsXlsxSummaryAggregate {
  /** Column header for this aggregate. */
  readonly label: string
  readonly op: 'sum' | 'count' | 'avg'
  /** Field to aggregate — required for `sum`/`avg`, ignored for `count`. */
  readonly field?: string
}

/**
 * A groupBy summary sheet (#414 P3): groups the source collection's sheet by
 * `groupBy` and emits live SUMIFS/COUNTIFS/AVERAGEIFS columns (values cached at
 * export). The source value columns must be numeric for the live formulas to
 * compute (apply `numberFormats` to money fields).
 */
export interface AsXlsxSummarySpec {
  /** Summary sheet name. */
  readonly name: string
  /** Source collection (must be exported as a sheet). */
  readonly from: string
  /** Field to group by. */
  readonly groupBy: string
  readonly aggregates: readonly AsXlsxSummaryAggregate[]
}

/** Single-collection convenience — passed where a sheet-list is accepted. */
export interface AsXlsxOptions {
  /** One or more sheets. At least one required. */
  readonly sheets: readonly AsXlsxSheetOptions[]
  /** Smart mode only: groupBy summary sheets (live SUMIFS/COUNTIFS/AVERAGEIFS). */
  readonly summaries?: readonly AsXlsxSummarySpec[]
  /**
   * Smart mode only: summary formula dialect. `'excel'` (default) emits
   * cross-compatible per-row SUMIFS/COUNTIFS/AVERAGEIFS. `'sheets'` emits a
   * single Google-Sheets `QUERY` formula per summary — **Sheets-only** (QUERY
   * errors in Excel); use when the target is Google Sheets.
   */
  readonly dialect?: 'excel' | 'sheets'
  /**
   * Smart-workbook mode (#414). Emits a relational workbook instead of a flat
   * dump:
   *   - every sheet is **id-first** (record `id` in column A);
   *   - each foreign-key field (auto-detected via `vault.dumpSchema()`) gets a
   *     `<field>__label` column — a cross-sheet `VLOOKUP` that resolves the
   *     reference to the target's first field, carrying a **cached** label so it
   *     shows immediately and recomputes live on edit;
   *   - a `_manifest` index sheet lists every collection, its row count, and
   *     its refs.
   *
   * Requires unique sheet names ≤ 31 chars (so cross-sheet refs resolve) and an
   * `id` field on records. Defaults to the existing flat export when omitted.
   */
  readonly smart?: boolean
  /**
   * Apply the hub's `applyListProjection` read-projection to every sheet's
   * records before rendering. `true` redacts only `classifiedFields` (mask /
   * omit / rider, per the field's preset). The object form additionally
   * redacts fields carrying a plain `fieldMeta` `sensitivity: 'pii' |
   * 'secret'` tag, per `sensitivity: 'omit' | 'mask'`.
   *
   * Caveat: `describe()` reflects the declarations of *this session's*
   * collection instance — redaction only takes effect when the collection
   * was opened (this call or earlier in the session) with its
   * `classifiedFields` / `fieldMeta` options. This is presentation-layer
   * redaction; it never affects what's on disk. Sealed handles are
   * unaffected either way — they always serialize as `'[sealed]'`, so
   * ciphertext never leaks regardless of this option.
   *
   * Rider companion fields (e.g. `pan_last4`) remain visible as their own
   * columns — they are safe write-time projections.
   */
  readonly redact?: boolean | { readonly sensitivity: 'omit' | 'mask' }
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

  if (options.smart) {
    const { sheets, definedNames } = await buildSmartSheets(vault, options)
    return writeXlsx(sheets, { definedNames })
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
    const projected = projectRecords(vault, sheetOpt.collection, records, options.redact)
    const columns = sheetOpt.columns ?? inferColumns(projected)
    materialisedSheets.push({
      name: sheetOpt.name,
      header: columns,
      rows: projected.map((r) => columns.map((c) => r[c] ?? null)),
      ...(sheetOpt.widths !== undefined ? { widths: sheetOpt.widths } : {}),
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

// ── multi-vault export ─────────────────────────────────────────────

/**
 * One vault entry in a multi-vault export. Supplies the pre-opened
 * vault, the sheet specs to render for it, and an optional closure
 * (per-collection id allowlist computed externally by the orchestrator).
 */
export interface MultiVaultXlsxEntry {
  readonly vault: Vault
  readonly sheets: readonly AsXlsxSheetOptions[]
  /**
   * Optional per-collection id allowlist (e.g. from walkCrossVaultClosure).
   * When set, only rows whose `id` appears in the set are exported for that
   * collection. Omit to export all rows.
   */
  readonly closure?: ReadonlyMap<string, ReadonlySet<string>>
  /**
   * Optional display label for sheet-name prefixing.
   * Defaults to `vault.name`.
   */
  readonly label?: string
  /**
   * Same semantics as {@link AsXlsxOptions.redact}, applied to this entry's
   * sheets via `entry.vault.collection(sheetCollection).describe()` — each
   * entry's own vault, since a multi-vault export spans several sessions.
   */
  readonly redact?: boolean | { readonly sensitivity: 'omit' | 'mask' }
}

/** Options for {@link toBytesMultiVault}. */
export interface MultiVaultXlsxOptions {
  /**
   * Separator inserted between the vault label and the sheet name when
   * building tab names. Default `'_'`. Names are then truncated to 31 chars
   * (Excel limit) by `writeXlsx`.
   */
  readonly sheetSeparator?: string
}

/**
 * Build an `.xlsx` byte stream spanning **multiple vaults**. Each entry
 * supplies a pre-opened vault with its sheet specs and an optional
 * per-collection id-closure (rows filtered to exactly those ids). A
 * `_manifest` sheet is prepended that lists every vault-collection pair
 * and its exported record count.
 *
 * ## Auth
 * Every vault in `entries` must independently hold `assertCanExport('plaintext','xlsx')`.
 * The check fires fail-fast before any rows are materialised.
 *
 * ## Architecture
 * This function is **edge-pure** — it takes pre-opened vaults and a
 * pre-computed closure; it performs no cross-vault FK walk itself.
 * Cross-vault orchestration lives in the outward orchestration layer (allowed direction).
 *
 * ## Two-pass execution (when `denormalize` is declared)
 * **Pass 1** — load and closure-filter ALL entries' rows, building a
 * `Map<"${label}/${collection}", Map<keyValue, row>>` index keyed by each
 * sheet's `keyField` (default `'id'`). Only closure-filtered rows are indexed,
 * so an FK pointing outside the closure yields an empty cell (correct: that
 * row was not referenced / not exported).
 * **Pass 2** — emit each sheet; for sheets with `denormalize`, append each
 * denorm column AFTER the declared columns by resolving the index lookup.
 */
export async function toBytesMultiVault(
  entries: readonly MultiVaultXlsxEntry[],
  options: MultiVaultXlsxOptions = {},
): Promise<Uint8Array> {
  const sep = options.sheetSeparator ?? '_'

  // Fail-fast auth check on every vault before materialising any rows.
  for (const entry of entries) {
    entry.vault.assertCanExport('plaintext', 'xlsx')
  }

  // ── Pass 1: load + closure-filter all rows, build denorm index ────

  /** Loaded rows per (label, collection) pair. */
  interface LoadedSheet {
    entry: MultiVaultXlsxEntry
    prefix: string
    sheetOpt: AsXlsxSheetOptions
    records: Record<string, unknown>[]
  }
  const loaded: LoadedSheet[] = []

  /** Denorm index: `"${label}/${collection}" → Map<keyValue, row>`. */
  const denormIndex = new Map<string, Map<string, Record<string, unknown>>>()

  for (const entry of entries) {
    const prefix = entry.label ?? entry.vault.name
    for (const s of entry.sheets) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all = await entry.vault.collection<any>(s.collection).list()
      const records: Record<string, unknown>[] = []
      for (const item of all) {
        const r = item as Record<string, unknown>
        // Closure filter: if a closure is supplied for this collection, keep
        // only rows whose id is in the allowlist.
        const allow = entry.closure?.get(s.collection)
        if (allow && !allow.has(String((r as { id?: unknown }).id))) continue
        // User-supplied row predicate (same semantics as single-vault toBytes).
        if (s.filter && !s.filter(r)) continue
        records.push(r)
      }
      const projected = projectRecords(entry.vault, s.collection, records, entry.redact)
      loaded.push({ entry, prefix, sheetOpt: s, records: projected })

      // Build index for this collection, keyed by every field that any denorm
      // might reference as `keyField`. We index by `id` by default, and also
      // by any explicitly declared `keyField` that differs from `'id'`.
      const indexKey = `${prefix}/${s.collection}`
      const collectionIndex = denormIndex.get(indexKey) ?? new Map<string, Record<string, unknown>>()
      denormIndex.set(indexKey, collectionIndex)
      for (const r of projected) {
        // Always index by `id` (most common key) and by any declared keyFields.
        const idVal = (r as { id?: unknown }).id
        if (idVal != null) collectionIndex.set(safeStringify(idVal), r)
      }
    }
  }

  // If any sheet declares denormalize with a non-'id' keyField, also index by that.
  for (const ls of loaded) {
    for (const d of ls.sheetOpt.denormalize ?? []) {
      if (d.from.keyField === 'id') continue // already indexed
      const indexKey = `${d.from.label}/${d.from.collection}`
      const idx = denormIndex.get(indexKey)
      if (!idx) continue
      // Find the loaded sheet for that label+collection and re-index by keyField.
      const srcLoaded = loaded.find(
        (l) => l.prefix === d.from.label && l.sheetOpt.collection === d.from.collection,
      )
      if (!srcLoaded) continue
      for (const r of srcLoaded.records) {
        const kv = r[d.from.keyField]
        if (kv != null) idx.set(safeStringify(kv), r)
      }
    }
  }

  // ── Pass 2: emit sheets with optional denorm columns ─────────────

  const allSheets: XlsxSheet[] = []
  const manifestRows: (string | number)[][] = []

  for (const { prefix, sheetOpt: s, records } of loaded) {
    const baseColumns = s.columns ?? inferColumns(records)
    const denormDefs = s.denormalize ?? []

    if (denormDefs.length === 0) {
      // Fast path: no denorm — identical to Task 1 behaviour.
      const sheetName = `${prefix}${sep}${s.name}`
      allSheets.push(buildFlatSheet(sheetName, baseColumns, records))
      manifestRows.push([prefix, s.collection, records.length])
      continue
    }

    // Denorm path: append extra columns after the declared ones.
    const allColumns = [...baseColumns, ...denormDefs.map((d) => d.column)]
    const sheetName = `${prefix}${sep}${s.name}`
    const rows = records.map((r) => {
      const baseCells = baseColumns.map((c) => r[c] ?? null)
      const denormCells = denormDefs.map((d) => {
        const idxKey = `${d.from.label}/${d.from.collection}`
        const idx = denormIndex.get(idxKey)
        if (!idx) return ''
        const fkVal = r[d.localField]
        if (fkVal == null) return ''
        const supporting = idx.get(safeStringify(fkVal))
        if (!supporting) return '' // unresolved FK → empty cell
        return supporting[d.from.pick] ?? ''
      })
      return [...baseCells, ...denormCells]
    })
    allSheets.push({ name: sheetName, header: allColumns, rows })
    manifestRows.push([prefix, s.collection, records.length])
  }

  // Prepend the _manifest sheet.
  allSheets.unshift({
    name: '_manifest',
    header: ['Vault', 'Collection', 'Records'],
    rows: manifestRows,
  })

  return writeXlsx(allSheets)
}

// ── internals ─────────────────────────────────────────────────────

/**
 * Apply `AsXlsxOptions.redact` to a sheet's records via the hub's
 * `applyListProjection`, describing the collection on its own vault (each
 * sheet/path may have a different vault instance — multi-vault entries in
 * particular). No-op (returns a shallow copy) when `redact` is unset.
 */
function projectRecords(
  vault: Vault,
  collectionName: string,
  records: readonly Record<string, unknown>[],
  redact: AsXlsxOptions['redact'],
): Record<string, unknown>[] {
  if (redact === undefined || redact === false) return [...records]
  const desc = vault.collection(collectionName).describe()
  const projectionOpts = redact === true ? undefined : { sensitivity: redact.sensitivity }
  return records.map((r) => applyListProjection(desc, r, projectionOpts))
}

/**
 * Build a flat {@link XlsxSheet} from pre-filtered records.
 * Used by both {@link toBytes} (via its own inline path) and
 * {@link toBytesMultiVault}.
 */
function buildFlatSheet(
  name: string,
  columns: readonly string[],
  records: readonly Record<string, unknown>[],
): XlsxSheet {
  return {
    name,
    header: [...columns],
    rows: records.map((r) => columns.map((c) => r[c] ?? null)),
  }
}

/** Safely stringify an unknown id/code/label (objects → JSON, never '[object Object]'). */
function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (v == null) return ''
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}

/** Coerce an arbitrary value to a formula cached-value (string/number/boolean). */
function asCached(v: unknown): string | number | boolean {
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v
  return safeStringify(v)
}

/**
 * Smart-workbook builder (#414 P1+P2): id-first sheets, FK→VLOOKUP label columns,
 * a `_manifest` index, and — when i18n fields are declared — per-locale columns
 * with a display column driven live by a global `LANG` named range on a
 * `_settings` sheet. Refs auto-detected from `vault.dumpSchema()`.
 */
async function buildSmartSheets(
  vault: Vault,
  options: AsXlsxOptions,
): Promise<{ sheets: XlsxSheet[]; definedNames: { name: string; ref: string }[] }> {
  const snapshot = await vault.dumpSchema()
  const sheetNameByCollection = new Map<string, string>()
  for (const s of options.sheets) sheetNameByCollection.set(s.collection, s.name)

  interface Mat {
    opt: AsXlsxSheetOptions
    records: Record<string, unknown>[]
    cols: string[]
    labelMap: Map<string, unknown>
    i18nFields: string[]
  }
  const mats: Mat[] = []
  const localeSet = new Set<string>()
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
    const projected = projectRecords(vault, sheetOpt.collection, records, options.redact)
    const base = sheetOpt.columns ?? inferColumns(projected)
    const cols = ['id', ...base.filter((c) => c !== 'id')]
    const labelCol = cols.find((c) => c !== 'id')
    const labelMap = new Map<string, unknown>()
    if (labelCol) for (const r of projected) if (r.id != null) labelMap.set(safeStringify(r.id), r[labelCol])
    const i18nFields = (sheetOpt.i18nFields ?? []).filter((f) => cols.includes(f))
    for (const f of i18nFields) {
      for (const r of projected) {
        const v = r[f]
        if (v && typeof v === 'object') for (const loc of Object.keys(v as Record<string, unknown>)) localeSet.add(loc)
      }
    }
    mats.push({ opt: sheetOpt, records: projected, cols, labelMap, i18nFields })
  }
  const matByCollection = new Map(mats.map((m) => [m.opt.collection, m]))

  // Load declared dictionaries once; merge their locales into the global set.
  const dictEntries = new Map<string, DictEntry[]>()
  for (const m of mats) {
    for (const [field, dictName] of Object.entries(m.opt.dictFields ?? {})) {
      if (!m.cols.includes(field) || dictEntries.has(dictName)) continue
      dictEntries.set(dictName, await vault.dictionary(dictName).list())
    }
  }
  for (const entries of dictEntries.values()) {
    for (const e of entries) for (const loc of Object.keys(e.labels)) localeSet.add(loc)
  }

  const locales = [...localeSet].sort()
  const hasLang = locales.length > 0
  const defaultLocale = locales.includes('en') ? 'en' : (locales[0] ?? 'en')
  // Build an IF-chain over the per-locale cells, switched by the LANG name.
  const ifChain = (refOf: (loc: string) => string): string => {
    if (locales.length === 0) return '""'
    let expr = refOf(locales[0]!)
    for (let k = locales.length - 1; k >= 0; k--) {
      expr = `IF(LANG="${locales[k]}",${refOf(locales[k]!)},${expr})`
    }
    return expr
  }

  // Per-collection sheet metadata so summaries can reference data-sheet columns.
  const sheetMeta = new Map<string, { name: string; colIndex: Map<string, number> }>()

  const dataSheets: XlsxSheet[] = mats.map((m) => {
    const refs = snapshot.collections[m.opt.collection]?.refs ?? {}
    const fields = snapshot.collections[m.opt.collection]?.fields ?? {}
    const i18nSet = new Set(m.i18nFields)
    const refFields = Object.keys(refs).filter((f) => m.cols.includes(f) && matByCollection.has(refs[f]!.target))
    const baseCols = m.cols.filter((c) => !i18nSet.has(c))
    const i18nFlat = m.i18nFields.flatMap((f) => [f, ...locales.map((l) => `${f}__${l}`)])
    const dictPairs = Object.entries(m.opt.dictFields ?? {}).filter(([f]) => m.cols.includes(f))
    const header = [
      ...baseCols,
      ...i18nFlat,
      ...dictPairs.map(([f]) => `${f}__label`),
      ...refFields.map((f) => `${f}__label`),
    ]
    const colIndex = new Map<string, number>()
    header.forEach((h, i) => colIndex.set(h, i + 1))
    sheetMeta.set(m.opt.collection, { name: m.opt.name, colIndex })

    // Data-validation dropdowns on base columns: explicit > ref-range > enum.
    const lastRow = Math.max(m.records.length + 1, 2)
    const validations: XlsxValidation[] = []
    for (const field of baseCols) {
      const colL = colLetter(colIndex.get(field)!)
      const sqref = `${colL}2:${colL}${lastRow}`
      const explicit = m.opt.dropdowns?.[field]
      if (explicit && explicit.length > 0) {
        validations.push({ sqref, values: explicit })
        continue
      }
      const rf = refs[field]
      if (rf && matByCollection.has(rf.target)) {
        const targetSheet = sheetNameByCollection.get(rf.target)!
        const targetRows = Math.max(matByCollection.get(rf.target)!.records.length + 1, 2)
        validations.push({ sqref, formula1: `'${targetSheet}'!$A$2:$A$${targetRows}` })
        continue
      }
      const enumVals = fields[field]?.constraints?.['values']
      if (Array.isArray(enumVals) && enumVals.length > 0) validations.push({ sqref, values: enumVals.map((v) => safeStringify(v)) })
    }

    const rows = m.records.map((r, i) => {
      const rowNum = i + 2 // header is row 1
      const baseCells = baseCols.map((c) => {
        const raw = c === 'id' ? (r.id ?? null) : (r[c] ?? null)
        const fmt = m.opt.numberFormats?.[c]
        if (fmt === undefined) return raw
        const num = typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw
        return styled(num as string | number | boolean | null, fmt)
      })
      const i18nCells = m.i18nFields.flatMap((f) => {
        const rawMap = (r[f] && typeof r[f] === 'object' ? r[f] : {}) as Record<string, unknown>
        const display = formula(
          ifChain((l) => `${colLetter(colIndex.get(`${f}__${l}`)!)}${rowNum}`),
          asCached(rawMap[defaultLocale] ?? ''),
        )
        return [display, ...locales.map((l) => (rawMap[l] ?? null) as unknown)]
      })
      const dictCells = dictPairs.map(([f, dn]) => {
        const codeRef = `${colLetter(colIndex.get(f)!)}${rowNum}`
        const lk = `_Lookups_${dn}`
        // MATCH(LANG, lookup header row) → the locale's column in the lookup sheet.
        const f1 = `IFERROR(VLOOKUP(${codeRef},'${lk}'!$A:$ZZ,MATCH(LANG,'${lk}'!$1:$1,0),FALSE),${codeRef})`
        const code = r[f]
        const entry = code == null ? undefined : dictEntries.get(dn)?.find((e) => e.key === safeStringify(code))
        return formula(f1, asCached(entry?.labels[defaultLocale] ?? (code ?? '')))
      })
      const refCells = refFields.map((f) => {
        const target = refs[f]!.target
        const targetSheet = sheetNameByCollection.get(target)!
        const targetMat = matByCollection.get(target)!
        const codeRef = `${colLetter(colIndex.get(f)!)}${rowNum}`
        const f1 = `IFERROR(VLOOKUP(${codeRef},'${targetSheet}'!$A:$ZZ,2,FALSE),"")`
        const code = r[f]
        const cached = code == null ? '' : asCached(targetMat.labelMap.get(safeStringify(code)))
        return formula(f1, cached)
      })
      return [...baseCells, ...i18nCells, ...dictCells, ...refCells]
    })
    return {
      name: m.opt.name,
      header,
      rows,
      ...(validations.length > 0 ? { validations } : {}),
      ...(m.opt.widths !== undefined ? { widths: m.opt.widths } : {}),
    }
  })

  const manifest: XlsxSheet = {
    name: '_manifest',
    header: ['Collection', 'Records', 'Refs'],
    rows: mats.map((m) => {
      const refs = snapshot.collections[m.opt.collection]?.refs ?? {}
      return [m.opt.name, m.records.length, Object.entries(refs).map(([f, r]) => `${f}→${r.target}`).join(', ')]
    }),
  }

  // Global LANG control — a Settings sheet + named range every i18n/dict label
  // references via IF(LANG=…). Only emitted when there are i18n fields.
  // GroupBy summary sheets (#414 P3/P5). Excel dialect (default): per-row live
  // SUMIFS/COUNTIFS/AVERAGEIFS, values cached. Sheets dialect: a single
  // Google-Sheets QUERY formula (Sheets-only — QUERY errors in Excel).
  const dialect = options.dialect ?? 'excel'
  const summarySheets: XlsxSheet[] = []
  for (const spec of options.summaries ?? []) {
    const src = sheetMeta.get(spec.from)
    const srcMat = matByCollection.get(spec.from)
    const gCol = src?.colIndex.get(spec.groupBy)
    if (!src || !srcMat || gCol === undefined) continue
    const gLetter = colLetter(gCol)

    if (dialect === 'sheets') {
      // One live QUERY formula that spills the grouped table (#414 P5).
      const selects: string[] = []
      const labels: string[] = []
      for (const a of spec.aggregates) {
        if (a.op === 'count') {
          selects.push(`COUNT(${gLetter})`)
          labels.push(`COUNT(${gLetter}) '${a.label}'`)
          continue
        }
        const vIdx = a.field ? src.colIndex.get(a.field) : undefined
        if (vIdx === undefined) continue
        const vL = colLetter(vIdx)
        const fn = a.op === 'sum' ? 'SUM' : 'AVG'
        selects.push(`${fn}(${vL})`)
        labels.push(`${fn}(${vL}) '${a.label}'`)
      }
      const q = `QUERY('${src.name}'!A:ZZ, "SELECT ${gLetter}, ${selects.join(', ')} GROUP BY ${gLetter} LABEL ${labels.join(', ')}", 1)`
      summarySheets.push({ name: spec.name, rows: [[formula(q)]] })
      continue
    }

    const seen = new Set<string>()
    const groups: unknown[] = []
    for (const r of srcMat.records) {
      const k = safeStringify(r[spec.groupBy])
      if (!seen.has(k)) {
        seen.add(k)
        groups.push(r[spec.groupBy])
      }
    }
    const header = [spec.groupBy, ...spec.aggregates.map((a) => a.label)]
    const rows = groups.map((g, i) => {
      const rowNum = i + 2
      const groupRecs = srcMat.records.filter((r) => safeStringify(r[spec.groupBy]) === safeStringify(g))
      const cells: unknown[] = [g]
      for (const a of spec.aggregates) {
        if (a.op === 'count') {
          cells.push(formula(`COUNTIFS('${src.name}'!$${gLetter}:$${gLetter},$A${rowNum})`, groupRecs.length))
          continue
        }
        const vIdx = a.field ? src.colIndex.get(a.field) : undefined
        if (vIdx === undefined) {
          cells.push(null)
          continue
        }
        const vLetter = colLetter(vIdx)
        const nums = groupRecs.map((r) => Number(r[a.field!])).filter((n) => Number.isFinite(n))
        const sum = nums.reduce((s, n) => s + n, 0)
        const cached = a.op === 'sum' ? sum : nums.length ? sum / nums.length : 0
        const fn = a.op === 'sum' ? 'SUMIFS' : 'AVERAGEIFS'
        cells.push(
          formula(`${fn}('${src.name}'!$${vLetter}:$${vLetter},'${src.name}'!$${gLetter}:$${gLetter},$A${rowNum})`, cached),
        )
      }
      return cells
    })
    summarySheets.push({ name: spec.name, header, rows })
  }

  // Hidden lookup sheets: one per declared dictionary (code + per-locale labels).
  const lookupSheets: XlsxSheet[] = [...dictEntries.entries()].map(([dn, entries]) => ({
    name: `_Lookups_${dn}`,
    header: ['Code', ...locales],
    rows: entries.map((e) => [e.key, ...locales.map((l) => e.labels[l] ?? '')]),
  }))

  const settingsSheets: XlsxSheet[] = []
  const definedNames: { name: string; ref: string }[] = []
  if (hasLang) {
    settingsSheets.push({
      name: '_settings',
      header: ['Setting', 'Value'],
      rows: [['Language', defaultLocale]],
      validations: [{ sqref: 'B2:B2', values: locales }],
    })
    definedNames.push({ name: 'LANG', ref: `'_settings'!$B$2` })
  }

  return {
    sheets: [...settingsSheets, ...lookupSheets, manifest, ...summarySheets, ...dataSheets],
    definedNames,
  }
}

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

// ── Reader ──────────────────────────────────────

import { diffVault, type VaultDiff } from '@noy-db/hub'

export type ImportPolicy = 'merge' | 'replace' | 'insert-only'

/**
 * Thrown when a dict field contains two different keys whose labels are
 * identical in any locale — making label→key inversion ambiguous.
 *
 * @example
 *   dict has: { key: 'a', labels: { en: 'Open' } } and { key: 'b', labels: { th: 'Open' } }
 *   → XlsxDictAmbiguityError('status', 'Open')
 */
export class XlsxDictAmbiguityError extends Error {
  constructor(
    public readonly column: string,
    public readonly label: string,
  ) {
    super(
      `as-xlsx.fromBytes: dict for column "${column}" has ambiguous label "${label}" — ` +
        'it maps to more than one key across locales. ' +
        'Supply a stricter dict or resolve the label conflict before importing.',
    )
    this.name = 'XlsxDictAmbiguityError'
  }
}

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
  /**
   * Per-field dict definitions for label→key inversion. When a column
   * header matches a key here, cell values are matched against every
   * locale label in the dict entries; matching labels are replaced by
   * their stable key before building the ImportPlan.
   *
   * Takes precedence over any vault dictionary with the same name.
   * For fields not listed here, `fromBytes` automatically tries
   * `vault.dictionary(fieldName).list()` as a fallback.
   *
   * Unknown labels (no match in any locale) pass through as-is.
   */
  readonly dicts?: Readonly<Record<string, readonly DictEntry[]>>
  /**
   * Read a sheet produced by smart export (#414 P4). Reverses the smart layout:
   * reconstructs i18n fields from their per-locale columns (`<f>__<loc>` →
   * `{ loc: value }`), and drops derived columns — the i18n display column and
   * every `<f>__label` (FK/dict) formula column. Code columns (the real values)
   * pass through. Maps onto the existing collection schema (Mode A).
   */
  readonly smart?: boolean
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
 * Capability: `assertCanImport('plaintext', 'xlsx')`.
 * Atomicity: `apply()` runs inside `vault.noydb.transaction()`.
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
 * **Dict-label inversion** — supply `dicts` per field (or populate vault
 * dictionaries with `withI18n()`) and the reader automatically inverts
 * human labels back to their stable keys. Ambiguous labels throw
 * `XlsxDictAmbiguityError`; unknown labels pass through unchanged.
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

  // Build per-field inversion maps.
  // Priority: explicit dicts option > vault dictionary lookup.
  // Vault lookup fires for every column not covered by explicit dicts;
  // vault.dictionary(name).list() returns [] when no dict exists — safe to call on any name.
  const invertMaps = new Map<string, Map<string, string>>()
  const allFields = new Set(colToField.values())
  for (const field of allFields) {
    const explicitEntries = options.dicts?.[field]
    if (explicitEntries !== undefined && explicitEntries.length > 0) {
      invertMaps.set(field, buildInversionMap(field, explicitEntries))
      continue
    }
    try {
      const vaultEntries = await vault.dictionary(field).list()
      if (vaultEntries.length > 0) {
        invertMaps.set(field, buildInversionMap(field, vaultEntries))
      }
    } catch {
      // No dictionary for this field — skip silently
    }
  }

  // Smart layout: any `<base>__<suffix>` where suffix isn't 'label' marks an
  // i18n base whose display column (`<base>`) is a formula to be dropped and
  // whose per-locale columns rebuild the `{ loc: value }` map.
  const i18nBases = new Set<string>()
  if (options.smart) {
    for (const field of colToField.values()) {
      const m = /^(.+)__(.+)$/.exec(field)
      if (m && m[2] !== 'label') i18nBases.add(m[1]!)
    }
  }

  const records: Record<string, unknown>[] = []
  for (let i = headerRowIdx + 1; i < allRows.length; i++) {
    const row = allRows[i]!
    const record: Record<string, unknown> = {}
    let hasAny = false
    for (const [col, value] of Object.entries(row)) {
      const field = colToField.get(col)
      if (field === undefined) continue
      if (options.smart) {
        if (field.endsWith('__label')) continue // derived FK/dict label
        const lm = /^(.+)__(.+)$/.exec(field)
        if (lm && lm[2] !== 'label' && i18nBases.has(lm[1]!)) {
          const base = lm[1]!
          const coerced = coerceXlsxCell(value, types[base])
          if (coerced !== undefined && coerced !== '') {
            const map = (record[base] as Record<string, unknown> | undefined) ?? {}
            map[lm[2]!] = coerced
            record[base] = map
            hasAny = true
          }
          continue
        }
        if (i18nBases.has(field)) continue // i18n display column (formula)
      }
      const coerced = coerceXlsxCell(value, types[field])
      if (coerced !== undefined) {
        const invMap = invertMaps.get(field)
        if (invMap !== undefined && typeof coerced === 'string') {
          record[field] = invMap.get(coerced) ?? coerced
        } else {
          record[field] = coerced
        }
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
      // Routes through the transactionsStrategy seam — clear error when
      // withTransactions() isn't opted in.
      await vault.noydb.transaction((tx) => {
        const txVault = tx.vault(vault.name)
        for (const entry of plan.added) {
          txVault.collection(entry.collection).put(entry.id, entry.record, { reason: 'import:xlsx' })
        }
        if (policy !== 'insert-only') {
          for (const entry of plan.modified) {
            txVault.collection(entry.collection).put(entry.id, entry.record, { reason: 'import:xlsx' })
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

/**
 * Build a label→key inversion map from a list of DictEntry objects.
 * Scans every locale in every entry's labels map. Throws
 * XlsxDictAmbiguityError if the same label string appears for two
 * different keys across any locale.
 */
function buildInversionMap(column: string, entries: readonly DictEntry[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of entries) {
    for (const label of Object.values(entry.labels)) {
      if (label === '') continue
      const existing = map.get(label)
      if (existing !== undefined && existing !== entry.key) {
        throw new XlsxDictAmbiguityError(column, label)
      }
      map.set(label, entry.key)
    }
  }
  return map
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
