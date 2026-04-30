/**
 * Vault-level diff orchestrator.
 *
 * Compares a live `Vault`'s plaintext state against a candidate state
 * (another vault, a plain `{ collection: records[] }` map, or a vault
 * dump JSON) and returns a structured `VaultDiff` plan listing the
 * records that would be added, modified, or deleted to bring the live
 * vault into the candidate's shape.
 *
 * Builds on two existing record-level helpers:
 *
 *   1. `diff(a, b)` from `./history/diff.ts` — emits dot-pathed
 *      `DiffEntry[]` with `type: 'added' | 'removed' | 'changed'` for
 *      each changed field of two records. Used here for the
 *      `fieldDiffs` of every `modified` entry, and (with empty result)
 *      as the default deep-equal check.
 *
 *   2. `Vault.exportStream()` from `./vault.ts` — the canonical
 *      decrypt-and-stream-records iterator. Used to walk both sides
 *      when the candidate is itself a `Vault`. ACL-scoped: collections
 *      the caller can't read silently drop out, the same way every
 *      other plaintext-emitting export pipeline filters them.
 *
 * The new orchestration is the **vault-level** enumeration: bucket
 * each record id into added (only in candidate), deleted (only in
 * vault), or modified (in both with field changes); leave the
 * field-level granularity to the existing `diff()`.
 *
 * Use cases:
 *
 *   - Import preview (`@noy-db/as-*` `fromString` returns a plan
 *     whose body is a `VaultDiff`).
 *   - Backup verification ("does this `.noydb` bundle from yesterday
 *     match the current vault?").
 *   - Two-vault reconciliation ("what's different between Office A
 *     and Office B before we sync?").
 *   - Test assertions (golden-file testing with one-liner
 *     `expect(plan.summary).toEqual(...)`).
 *
 * @module
 */

import type { Vault } from './vault.js'
import { diff as fieldDiff, type DiffEntry as FieldDiffEntry } from './history/diff.js'

// ─── Public types ──────────────────────────────────────────────────────

/** Per-record entry shape — added and deleted records carry only the record value. */
export interface VaultDiffEntry<T = unknown> {
  readonly collection: string
  readonly id: string
  readonly record: T
}

/** Modified records carry both halves of the diff plus the field-level breakdown. */
export interface VaultDiffModifiedEntry<T = unknown> extends VaultDiffEntry<T> {
  /** The record as it stands in the live vault. */
  readonly before: T
  /** Top-level keys whose values differ between `before` and `record`. */
  readonly fieldsChanged: readonly string[]
  /**
   * Field-level diff entries from `diff(before, record)`. Reuses the
   * existing per-record diff helper so consumers can render git-style
   * `path: from → to` rows without re-walking the records.
   */
  readonly fieldDiffs: readonly FieldDiffEntry[]
}

export interface VaultDiff<T = unknown> {
  readonly added: readonly VaultDiffEntry<T>[]
  readonly modified: readonly VaultDiffModifiedEntry<T>[]
  readonly deleted: readonly VaultDiffEntry<T>[]
  /** Only populated when `options.includeUnchanged: true`. */
  readonly unchanged: readonly VaultDiffEntry<T>[] | undefined
  readonly summary: {
    readonly add: number
    readonly modify: number
    readonly delete: number
    readonly total: number
  }
  /**
   * Format the diff as a human-readable string.
   *
   *   - `'count'`   — one line, just the numbers (`12 added · 3 modified · 0 deleted`)
   *   - `'one-line'` — count plus a single overview line
   *   - `'full'`    — count + one row per added/modified/deleted record (default)
   */
  format(opts?: { detail?: 'count' | 'one-line' | 'full' }): string
}

export interface DiffOptions {
  /** Restrict the diff to a subset of collections. */
  readonly collections?: readonly string[]
  /** Field on each record that carries its id. Defaults to `'id'`. */
  readonly idKey?: string
  /** Override the default deep-equal check for "modified vs unchanged". */
  readonly compareFn?: (a: unknown, b: unknown) => boolean
  /** If true, include unchanged records in the diff (off by default to save memory). */
  readonly includeUnchanged?: boolean
}

/**
 * Candidate state to diff the vault against:
 *
 *   - A `Vault` instance — both sides are walked via `exportStream()`.
 *   - A `Record<collection, records[]>` map — same shape `as-json.toObject()`
 *     produces. Useful for diffing parsed file content against the live vault.
 *   - A `VaultDump` (output of `vault.dump()`) — a JSON string carrying the
 *     full vault state. Parsed and reduced to the map shape above.
 */
export type DiffCandidate<T = unknown> =
  | Vault
  | Record<string, readonly T[]>
  | string

// ─── Implementation ────────────────────────────────────────────────────

/**
 * Compute the diff between a live vault and a candidate state.
 *
 * Returns a fully buffered `VaultDiff` — no streaming. Memory cost is
 * O(n + m) in the row count of vault + candidate. For documented
 * 1K-50K-record vaults this is fine; a streaming variant lands as a
 * follow-up if a > 100K-record consumer arrives.
 */
export async function diffVault<T = unknown>(
  vault: Vault,
  candidate: DiffCandidate<T>,
  options: DiffOptions = {},
): Promise<VaultDiff<T>> {
  const idKey = options.idKey ?? 'id'
  const filter = options.collections ? new Set(options.collections) : null
  const compareFn =
    options.compareFn ?? ((a: unknown, b: unknown) => fieldDiff(a, b).length === 0)

  // Side A — walk the live vault via exportStream(). Each chunk arrives
  // already decrypted and ACL-scoped, so collections the caller can't
  // read silently drop out. exportStream's records are typed `unknown[]`
  // — diffVault is the type-erasure boundary; the caller asserts the
  // record shape via the function's `<T>` generic.
  const live = new Map<string, Map<string, T>>()
  for await (const chunk of vault.exportStream({ granularity: 'collection' })) {
    if (filter && !filter.has(chunk.collection)) continue
    const collection = live.get(chunk.collection) ?? new Map<string, T>()
    for (const record of chunk.records) {
      const id = readIdField(record, idKey)
      if (!id) continue
      collection.set(id, record as T)
    }
    live.set(chunk.collection, collection)
  }

  // Side B — normalise the candidate into the same shape.
  const cand = await normaliseCandidate<T>(candidate, idKey, filter)

  // Walk every (collection, id) on either side and bucket.
  const added: VaultDiffEntry<T>[] = []
  const modified: VaultDiffModifiedEntry<T>[] = []
  const deleted: VaultDiffEntry<T>[] = []
  const unchanged: VaultDiffEntry<T>[] | undefined = options.includeUnchanged ? [] : undefined

  const collectionNames = new Set([...live.keys(), ...cand.keys()])
  for (const collection of [...collectionNames].sort()) {
    const liveColl = live.get(collection) ?? new Map<string, T>()
    const candColl = cand.get(collection) ?? new Map<string, T>()
    const allIds = new Set([...liveColl.keys(), ...candColl.keys()])

    for (const id of [...allIds].sort()) {
      const before = liveColl.get(id)
      const after = candColl.get(id)

      if (before === undefined && after !== undefined) {
        added.push({ collection, id, record: after })
      } else if (before !== undefined && after === undefined) {
        deleted.push({ collection, id, record: before })
      } else if (before !== undefined && after !== undefined) {
        if (compareFn(before, after)) {
          unchanged?.push({ collection, id, record: after })
        } else {
          const fieldDiffs = fieldDiff(before, after)
          const fieldsChanged = uniqueTopLevelKeys(fieldDiffs)
          modified.push({
            collection,
            id,
            record: after,
            before,
            fieldsChanged,
            fieldDiffs,
          })
        }
      }
    }
  }

  const summary = {
    add: added.length,
    modify: modified.length,
    delete: deleted.length,
    total: added.length + modified.length + deleted.length,
  }

  return {
    added,
    modified,
    deleted,
    unchanged,
    summary,
    format(opts) {
      return formatDiff(opts?.detail ?? 'full', { added, modified, deleted, summary })
    },
  }
}

// ─── Internals ─────────────────────────────────────────────────────────

async function normaliseCandidate<T>(
  candidate: DiffCandidate<T>,
  idKey: string,
  filter: Set<string> | null,
): Promise<Map<string, Map<string, T>>> {
  const out = new Map<string, Map<string, T>>()

  // Vault instance — duck-type via the exportStream method (matches
  // vault.ts's structural shape without forcing a runtime instanceof check
  // that would import the class and risk circular deps).
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'exportStream' in candidate &&
    typeof (candidate as Vault).exportStream === 'function'
  ) {
    for await (const chunk of (candidate as Vault).exportStream({ granularity: 'collection' })) {
      if (filter && !filter.has(chunk.collection)) continue
      const collection = out.get(chunk.collection) ?? new Map<string, T>()
      for (const record of chunk.records) {
        const id = readIdField(record, idKey)
        if (!id) continue
        collection.set(id, record as T)
      }
      out.set(chunk.collection, collection)
    }
    return out
  }

  // String — assume a vault.dump() JSON string. Parse and reduce to the map shape.
  if (typeof candidate === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch (err) {
      throw new Error(
        `diffVault: candidate string is not valid JSON (${(err as Error).message})`,
      )
    }
    return collectionsFromObject<T>(parsed, idKey, filter)
  }

  // Plain object — `Record<collection, records[]>` (same shape as-json.toObject() returns).
  return collectionsFromObject<T>(candidate, idKey, filter)
}

function collectionsFromObject<T>(
  raw: unknown,
  idKey: string,
  filter: Set<string> | null,
): Map<string, Map<string, T>> {
  const out = new Map<string, Map<string, T>>()
  if (raw === null || typeof raw !== 'object') {
    throw new Error('diffVault: candidate must be a Vault, an object, or a JSON string')
  }
  // A vault dump JSON has a top-level shape like { _compartment, _keyring, <coll>: <records[]> }.
  // We accept both: keys starting with `_` are skipped (they're metadata), the rest are collections.
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue
    if (filter && !filter.has(key)) continue
    if (!Array.isArray(value)) continue
    const collection = new Map<string, T>()
    for (const record of value as readonly T[]) {
      if (record === null || typeof record !== 'object') continue
      const id = readIdField(record, idKey)
      if (!id) continue
      collection.set(id, record)
    }
    out.set(key, collection)
  }
  return out
}

function uniqueTopLevelKeys(diffs: readonly FieldDiffEntry[]): readonly string[] {
  const keys = new Set<string>()
  for (const d of diffs) {
    // path is dot-separated; the top-level key is everything before the
    // first `.` or `[`. (`a.b.c` → `a`, `tags[0]` → `tags`, `(root)` → `(root)`).
    const m = /^[^.[]+/.exec(d.path)
    if (m) keys.add(m[0])
  }
  return [...keys]
}

/**
 * Pull the id field off a record without going through `String(obj)`,
 * which would emit `[object Object]` for nested objects and silently
 * collapse rows that share the same parent. Only string and number ids
 * are accepted; anything else returns the empty string and the record
 * is skipped at the call site.
 */
function readIdField(record: unknown, idKey: string): string {
  if (record === null || typeof record !== 'object') return ''
  const v = (record as Record<string, unknown>)[idKey]
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

interface FormatBuckets<T> {
  readonly added: readonly VaultDiffEntry<T>[]
  readonly modified: readonly VaultDiffModifiedEntry<T>[]
  readonly deleted: readonly VaultDiffEntry<T>[]
  readonly summary: VaultDiff<T>['summary']
}

function formatDiff<T>(
  detail: 'count' | 'one-line' | 'full',
  b: FormatBuckets<T>,
): string {
  const head = `${b.summary.add} added · ${b.summary.modify} modified · ${b.summary.delete} deleted`
  if (detail === 'count') return head
  if (b.summary.total === 0) return head + '\n(no changes)'
  if (detail === 'one-line') return head

  const rows: string[] = [head, '']
  for (const e of b.added) rows.push(`${e.collection}/${e.id}\tadded`)
  for (const e of b.modified) {
    const fields = e.fieldDiffs
      .map((f) => `${f.path}: ${shortJSON(f.from)} → ${shortJSON(f.to)}`)
      .join(', ')
    rows.push(`${e.collection}/${e.id}\tmodified\t${fields}`)
  }
  for (const e of b.deleted) rows.push(`${e.collection}/${e.id}\tdeleted`)
  return rows.join('\n')
}

function shortJSON(value: unknown): string {
  if (value === undefined) return 'undefined'
  const s = JSON.stringify(value)
  // JSON.stringify returns string for any JSON value except `undefined`
  // (handled above), `function`, and `symbol`. Fall back to a static
  // tag for those — never let an arbitrary object hit the default
  // stringifier (which the lint rule explicitly bans).
  if (typeof s !== 'string') return '<unrepresentable>'
  return s.length > 60 ? s.slice(0, 57) + '...' : s
}
