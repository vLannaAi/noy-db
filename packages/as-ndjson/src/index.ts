/**
 * **@noy-db/as-ndjson** — newline-delimited JSON plaintext export.
 *
 * Streaming-friendly sibling to `@noy-db/as-json`. Emits one JSON
 * object per line, each carrying a `_schema` field naming the source
 * collection so a downstream reader can route records without a
 * separate header pass:
 *
 * ```
 * {"_schema":"invoices","id":"i1","amount":100,...}
 * {"_schema":"invoices","id":"i2","amount":250,...}
 * {"_schema":"payments","id":"p1","invoiceId":"i1","amount":100,...}
 * ```
 *
 * Best for large vaults (10K+ records) where loading a single JSON
 * array into memory is clumsy. Pipes cleanly into `jq`, `fx`, log
 * stacks, or any line-oriented reducer.
 *
 * @packageDocumentation
 */

import type { Vault } from '@noy-db/hub'

export interface AsNDJSONOptions {
  /** Collection allowlist. Omit for every collection the caller can read. */
  readonly collections?: readonly string[]
  /** Include envelope metadata (`_v`, `_ts`, `_by`) on each line. Default `false`. */
  readonly includeMeta?: boolean
  /** Name of the routing field. Default `'_schema'`. */
  readonly schemaField?: string
}

export interface AsNDJSONDownloadOptions extends AsNDJSONOptions {
  /** Filename offered to the browser. Default `'vault-export.ndjson'`. */
  readonly filename?: string
}

export interface AsNDJSONWriteOptions extends AsNDJSONOptions {
  /** Required to write plaintext NDJSON to disk — Tier 3 risk gate. */
  readonly acknowledgeRisks: true
}

/**
 * Async iterator emitting one NDJSON-formatted line per record (no
 * trailing newline — the caller decides). The authorization check
 * runs before the first record is produced.
 */
export async function* stream(vault: Vault, options: AsNDJSONOptions = {}): AsyncGenerator<string> {
  vault.assertCanExport('plaintext', 'ndjson')
  const allowlist = options.collections ? new Set(options.collections) : null
  const schemaField = options.schemaField ?? '_schema'

  for await (const chunk of vault.exportStream({ granularity: 'record' })) {
    if (allowlist && !allowlist.has(chunk.collection)) continue
    for (const record of chunk.records) {
      const base = options.includeMeta
        ? (record as Record<string, unknown>)
        : stripMeta(record as Record<string, unknown>)
      const out: Record<string, unknown> = { [schemaField]: chunk.collection, ...base }
      yield JSON.stringify(out)
    }
  }
}

/** Collect the full NDJSON export into a single string (in-memory). */
export async function toString(vault: Vault, options: AsNDJSONOptions = {}): Promise<string> {
  const lines: string[] = []
  for await (const line of stream(vault, options)) lines.push(line)
  return lines.join('\n')
}

/** Browser download wrapping `toString()` in a Blob save-as prompt. */
export async function download(vault: Vault, options: AsNDJSONDownloadOptions = {}): Promise<void> {
  const ndjson = await toString(vault, options)
  const filename = options.filename ?? 'vault-export.ndjson'
  const blob = new Blob([ndjson + '\n'], { type: 'application/x-ndjson;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Node pipe: stream each line into a WritableStream-like sink (a
 * `fs.WriteStream`, `process.stdout`, or any `.write(chunk)` +
 * `.end()` duck). Memory usage is O(one record) regardless of vault
 * size.
 */
export async function pipe(
  vault: Vault,
  sink: { write(chunk: string): unknown; end?(): void },
  options: AsNDJSONWriteOptions,
): Promise<void> {
  if (options.acknowledgeRisks !== true) {
    throw new Error(
      'as-ndjson.pipe: acknowledgeRisks: true is required for on-disk plaintext output. ' +
      'See docs/patterns/as-exports.md §"The three tiers of \\"plaintext out\\""',
    )
  }
  for await (const line of stream(vault, options)) {
    sink.write(line + '\n')
  }
  sink.end?.()
}

function stripMeta(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === '_v' || key === '_ts' || key === '_by' || key === '_iv' || key === '_data' || key === '_noydb') continue
    out[key] = value
  }
  return out
}
