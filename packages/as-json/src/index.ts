/**
 * **@noy-db/as-json** — structured JSON plaintext export for noy-db.
 *
 * Decrypts ACL-scoped records from a vault and emits one structured
 * JSON document grouping records by collection. Sibling to the core
 * `exportJSON()` helper — same shape, but gated behind
 * `canExportPlaintext` (RFC #249) and paired with browser-download +
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
export async function toString(vault: Vault, options: AsJSONOptions = {}): Promise<string> {
  const doc = await toObject(vault, options)
  const indent = typeof options.pretty === 'number'
    ? options.pretty
    : options.pretty === false
      ? 0
      : 2
  return indent > 0 ? JSON.stringify(doc, null, indent) : JSON.stringify(doc)
}

/**
 * Serialise the vault as a plain JS object. Useful for in-process
 * pipelines that want to post-process the data before writing.
 */
export async function toObject(vault: Vault, options: AsJSONOptions = {}): Promise<AsJSONDocument> {
  vault.assertCanExport('plaintext', 'json')

  const allowlist = options.collections ? new Set(options.collections) : null
  const doc: Record<string, Record<string, unknown>[]> = {}
  for await (const chunk of vault.exportStream({ granularity: 'collection' })) {
    if (allowlist && !allowlist.has(chunk.collection)) continue
    const bucket = doc[chunk.collection] ?? (doc[chunk.collection] = [])
    for (const record of chunk.records) {
      if (options.includeMeta) {
        bucket.push(record as Record<string, unknown>)
      } else {
        bucket.push(stripMeta(record as Record<string, unknown>))
      }
    }
  }
  return doc
}

/**
 * Browser download — wraps `toString()` in a Blob and triggers the
 * browser's save-as prompt. Requires a DOM — in Node, use `write()`.
 */
export async function download(vault: Vault, options: AsJSONDownloadOptions = {}): Promise<void> {
  const json = await toString(vault, options)
  const filename = options.filename ?? 'vault-export.json'
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Node file-write — persists the JSON to disk. Requires
 * `acknowledgeRisks: true` because plaintext outlives the process.
 */
export async function write(
  vault: Vault,
  path: string,
  options: AsJSONWriteOptions,
): Promise<void> {
  if (options.acknowledgeRisks !== true) {
    throw new Error(
      'as-json.write: acknowledgeRisks: true is required for on-disk plaintext output. ' +
      'See docs/patterns/as-exports.md §"The three tiers of \\"plaintext out\\""',
    )
  }
  const json = await toString(vault, options)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, json, 'utf-8')
}

function stripMeta(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === '_v' || key === '_ts' || key === '_by' || key === '_iv' || key === '_data' || key === '_noydb') continue
    out[key] = value
  }
  return out
}
