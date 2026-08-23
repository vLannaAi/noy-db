/**
 * **@noy-db/as-json** — structured JSON plaintext export for noy-db.
 *
 * Decrypts ACL-scoped records from a vault and emits one structured
 * JSON document grouping records by collection. Sibling to the core
 * `exportJSON()` helper — same shape, but gated behind
 * `assertCanExport('plaintext')` and paired with browser-download +
 * Node file-write helpers.
 *
 * **Scope.** Multi-collection per call (unlike `as-csv` which is
 * single-collection). Whole-vault by default; pass `collections` to
 * restrict.
 *
 * See `docs/patterns/as-exports.md` for the three-tier egress model
 * (Tier 1 in-memory → Tier 2 browser download → Tier 3 disk write).
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

export interface AsJSONOptions {
  /**
   * Collection allowlist. When omitted, every collection the caller
   * can read is included. Collections not in the caller's ACL silently
   * drop out even when listed here — ACL-scoping runs at the
   * `exportStream` layer.
   */
  readonly collections?: readonly string[]

  /**
   * Pretty-print with indentation. Default `2` (2-space indent). Pass
   * `0` or `false` for compact single-line output.
   */
  readonly pretty?: number | boolean

  /**
   * Include envelope metadata (`_v`, `_ts`, `_by`) alongside each
   * record. Default `false` — stripped so the JSON matches the shape
   * of the raw records the consumer originally put.
   */
  readonly includeMeta?: boolean

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
   * fields (e.g. `pan_last4`) remain visible as their own keys — they
   * are safe write-time projections.
   */
  readonly redact?: boolean | { readonly sensitivity: 'omit' | 'mask' }
}

export interface AsJSONDownloadOptions extends AsJSONOptions {
  /** Filename offered to the browser. Default `'vault-export.json'`. */
  readonly filename?: string
}

export interface AsJSONWriteOptions extends AsJSONOptions {
  /** Required to write plaintext JSON to disk — Tier 3 risk gate. */
  readonly acknowledgeRisks: true
}

/**
 * Shape of the emitted document: one top-level key per collection,
 * each mapping to an array of record objects.
 */
export type AsJSONDocument = Record<string, readonly Record<string, unknown>[]>

/**
 * Serialise the vault as a JSON string. Pure operation — no side
 * effects beyond the authorization check and audit ledger write.
 */
/**
 * The pure encoders — records in, JSON out. Already gated and already redacted
 * by hub; neither has a vault (ADR 0004).
 */
function encodeJsonDoc(
  chunks: readonly ExportChunk[],
  options: AsJSONFormatOptions,
): AsJSONDocument {
  const doc: Record<string, Record<string, unknown>[]> = {}
  for (const chunk of chunks) {
    const bucket = doc[chunk.collection] ?? (doc[chunk.collection] = [])
    for (const record of chunk.records) {
      const r = record as Record<string, unknown>
      bucket.push(options.includeMeta ? r : stripMeta(r))
    }
  }
  return doc
}

function encodeJson(chunks: readonly ExportChunk[], options: AsJSONFormatOptions): string {
  const indent = typeof options.pretty === 'number' ? options.pretty : options.pretty === false ? 0 : 2
  return JSON.stringify(encodeJsonDoc(chunks, options), null, indent)
}


/**
 * Browser download — wraps `toString()` in a Blob and triggers the
 * browser's save-as prompt. Requires a DOM — in Node, use `write()`.
 */
/** Options a JSON format instance carries. Read concerns live on `vault.export`. */
export interface AsJSONFormatOptions {
  /** Indent width, or `false` for compact. Default 2. */
  readonly pretty?: number | boolean
  /** Keep `_noydb_*` metadata fields. Default false. */
  readonly includeMeta?: boolean
}

/**
 * The JSON format — the `as-*` port instance.
 *
 * Unlike CSV and XML, JSON carries collection names in the payload, so
 * `vault.import(asJson(), doc)` needs no `{ collection }`.
 */
export function asJson(options: AsJSONFormatOptions = {}): NoydbFormat<string> {
  return {
    id: 'json',
    extension: 'json',
    mimeType: 'application/json;charset=utf-8',
    tier: 'plaintext',
    encode: (chunks) => encodeJson(chunks, options),
    decode: (input) => decodeJson(input),
  }
}

/** Only the keys actually set — `exactOptionalPropertyTypes` is on. */
function fmtOpts(o: AsJSONOptions): AsJSONFormatOptions {
  return {
    ...(o.pretty !== undefined ? { pretty: o.pretty } : {}),
    ...(o.includeMeta !== undefined ? { includeMeta: o.includeMeta } : {}),
  }
}


function readOpts(o: AsJSONOptions): FormatExportOptions {
  return {
    ...(o.collections ? { collections: o.collections } : {}),
    ...(o.redact !== undefined && o.redact !== false
      ? { redact: o.redact === true ? true : { sensitivity: o.redact.sensitivity } }
      : {}),
  }
}

/**
 * Serialise to a JSON string.
 *
 * Kept as a thin wrapper rather than removed, unlike as-csv/as-sql/as-xml: the
 * gate, the read and the redaction still moved to hub, and this is now three
 * lines over `vault.export`. Its sibling `toObject` is the reason — a document
 * is not bytes, so `NoydbFormat<string>` cannot express it, and removing one
 * while keeping the other would be a worse API than keeping both.
 */
export async function toString(vault: Vault, options: AsJSONOptions = {}): Promise<string> {
  return vault.export(asJson(fmtOpts(options)), readOpts(options))
}

/**
 * Serialise to the parsed `{ collection: records[] }` document.
 *
 * The one export shape the format port does not carry, because a format
 * produces bytes by definition. Round-tripping through `encode` keeps a single
 * implementation rather than a second walk of the chunks.
 */
export async function toObject(vault: Vault, options: AsJSONOptions = {}): Promise<AsJSONDocument> {
  return JSON.parse(await toString(vault, options)) as AsJSONDocument
}

/** Browser download. Hub gates, reads and redacts; this wraps the bytes. */
export async function download(vault: Vault, options: AsJSONDownloadOptions = {}): Promise<void> {
  const fmt = asJson(fmtOpts(options))
  const json = await vault.export(fmt, readOpts(options))
  const url = URL.createObjectURL(new Blob([json], { type: fmt.mimeType }))
  const a = document.createElement('a')
  a.href = url
  a.download = options.filename ?? `vault-export.${fmt.extension}`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Node file write. Not in hub because `hub-portable` forbids Node builtins
 * there. The gate, the read and the redaction all moved.
 */
export async function write(vault: Vault, path: string, options: AsJSONWriteOptions): Promise<void> {
  if (options.acknowledgeRisks !== true) {
    throw new Error('as-json.write: acknowledgeRisks: true is required for on-disk plaintext output.')
  }
  const json = await vault.export(asJson(fmtOpts(options)), readOpts(options))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, json, 'utf8')
}


function stripMeta(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === '_v' || key === '_ts' || key === '_by' || key === '_iv' || key === '_data' || key === '_noydb') continue
    out[key] = value
  }
  return out
}

// ─── Reader ─────────────────────────────────────────────


/**
 * Reconciliation policy for `apply()`.
 *
 *   - `'merge'` (default) — insert + update, never delete. Records
 *     present in the live vault but absent from the file are left
 *     intact.
 *   - `'replace'` — full mirror. Records present in the live vault but
 *     absent from the file are deleted.
 *   - `'insert-only'` — only insert new records; skip both updates and
 *     deletes. Useful for append-only ledgers.
 */
// Hub-owned as of 0.7 (ADR 0004). This line replaced a local declaration that
// existed identically in six as-* packages, with nothing comparing them.
import type { ImportPolicy, ImportPlan } from '@noy-db/hub/as'
export type { ImportPolicy }

export interface AsJSONImportOptions {
  /** Restrict the diff + apply to a subset of collections. */
  readonly collections?: readonly string[]
  /** Field on each record that carries its id. Default `'id'`. */
  readonly idKey?: string
  /** Reconciliation policy. Default `'merge'`. */
  readonly policy?: ImportPolicy
}

/**
 * Output of `fromString` / `fromObject` — preview the changes a JSON
 * import would apply, then commit them with `apply()`. Two-step shape
 * keeps the diff cheap and lets consumers render review-and-confirm
 * UIs without a separate dry-run mode.
 */
export type AsJSONImportPlan = ImportPlan

/**
 * Build an import plan from a parsed JSON document. Same shape
 * `as-json.toObject()` produces — `Record<collection, records[]>`.
 */
/**
 * The pure decoder — JSON in, records out. No vault, no gate, no diff: hub
 * gates, plans against the live vault and owns `apply()`.
 */
function decodeJson(json: string): readonly DecodedChunk[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new Error(`as-json decode: input is not valid JSON (${(err as Error).message})`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('as-json decode: expected an object mapping { collection: records[] }')
  }
  // JSON DOES carry collection names — one key per collection — so unlike CSV
  // and XML this format needs no `{ collection }` from the caller.
  return Object.entries(parsed as Record<string, unknown>).map(([collection, records]) => ({
    collection,
    records: Array.isArray(records) ? records : [],
  }))
}

