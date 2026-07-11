/**
 * Pure dict-registry helpers — extracted from `kernel/vault.ts`'s dict
 * bodies (#650 Task 1 — via-lookup extraction, phase D).
 *
 * These take the vault-resident registry Maps (and a couple of vault-bound
 * callbacks) as ARGUMENTS instead of closing over `this` — no `Vault`
 * import here, so this module stays a plain, testable function library.
 * `kernel/vault.ts` keeps the registry Maps themselves (they're populated
 * by `vault.collection()` and read by the backup path) and calls these
 * helpers through the `port/with/lookup-strategy.ts` seam.
 */

import { getAtPath } from '../../kernel/paths.js'
import { UnknownDictCodeError } from '../../kernel/errors.js'
import type { JoinableSource } from '../../kernel/query/index.js'
import type { StaticDictDescriptor } from '../../port/with/i18n-strategy.js'
import type { LookupHandle } from './handle.js'

/**
 * Validate staticDict codes on a `put()`. For each `staticDict()` field,
 * every stored code must be a declared key of the descriptor's table, else
 * `UnknownDictCodeError`. Opt out per descriptor with `{ validateCodes:
 * false }`. Supports scalar, dotted, and `[].`-wildcard field paths via
 * `getAtPath` (same path support as i18n validation).
 *
 * `staticFields` is the collection's `field → StaticDictDescriptor` map
 * (`Vault#staticDescriptorByField.get(collectionName)`) — `undefined`/empty
 * is a no-op.
 */
export function enforceStaticDictOnPut(
  staticFields: Record<string, StaticDictDescriptor> | undefined,
  record: unknown,
): void {
  if (!staticFields || Object.keys(staticFields).length === 0) return
  if (!record || typeof record !== 'object') return

  const obj = record as Record<string, unknown>
  for (const [field, desc] of Object.entries(staticFields)) {
    if (desc.validateCodes === false) continue
    const known = new Set<string>(desc.keys)
    const values = getAtPath(obj, field)
    for (const value of values) {
      if (value === undefined || value === null) continue
      const codes = Array.isArray(value) ? value : [value]
      for (const code of codes) {
        if (typeof code !== 'string') continue
        if (!known.has(code)) {
          throw new UnknownDictCodeError(desc.name, field, code)
        }
      }
    }
  }
}

/**
 * Build a `JoinableSource` for a dictKey field, for use in dict joins.
 * Returns a source whose snapshot contains `{ key, labels, ...labels }`
 * records — one per dictionary entry — keyed by the stable key.
 *
 * staticDict: a code-table-backed source — snapshot() materialises the
 * in-memory table into rows, mirroring `LookupHandle.snapshotEntries()`.
 * Carries `displayLocale` so a locale-less `{ by: 'label' }` query has a
 * default locale to resolve at.
 *
 * Plain dictKey: the snapshot is built synchronously from the
 * `LookupHandle`'s write-through cache, which is populated on every
 * `put()`, `rename()`, `delete()`, and `list()` call. For pre-existing
 * data not yet touched this session, call `await vault.dictionary(name).list()`
 * first to warm the cache.
 *
 * Returns `null` when `field` is not a dictKey in `leftCollection`.
 */
export function resolveDictSource(
  leftCollection: string,
  field: string,
  staticDescriptorByField: ReadonlyMap<string, Record<string, StaticDictDescriptor>>,
  dictKeyFieldRegistry: ReadonlyMap<string, Record<string, string>>,
  getDictionaryHandle: (name: string) => LookupHandle,
): JoinableSource | null {
  const staticFields = staticDescriptorByField.get(leftCollection)
  if (staticFields && field in staticFields) {
    const desc = staticFields[field]!
    const rows: readonly Record<string, unknown>[] = Object.entries(desc.table).map(
      ([key, labels]) => ({ key, labels, ...(labels as Record<string, string>) }),
    )
    const source: JoinableSource = {
      snapshot(): readonly unknown[] {
        return rows
      },
      lookupById(id: string): unknown {
        return rows.find((e) => e['key'] === id)
      },
    }
    if (desc.displayLocale !== undefined) {
      ;(source as { displayLocale?: string }).displayLocale = desc.displayLocale
    }
    return source
  }

  const dictFields = dictKeyFieldRegistry.get(leftCollection)
  if (!dictFields || !(field in dictFields)) return null
  const dictName = dictFields[field]
  if (!dictName) return null
  const handle = getDictionaryHandle(dictName)
  return {
    snapshot(): readonly unknown[] {
      return handle.snapshotEntries()
    },
    lookupById(id: string): unknown {
      const entries = handle.snapshotEntries()
      return entries.find((e) => e['key'] === id)
    },
  }
}

/** The minimal collection surface `updateReferencingRecords` needs. */
export interface DictReferencingCollection {
  list(): Promise<Record<string, unknown>[]>
  put(id: string, record: Record<string, unknown>): Promise<unknown>
}

/**
 * Find and rewrite records in every registered collection whose
 * dictKeyField points at `name`, replacing `oldKey` with `newKey`. Used by
 * `LookupHandle.rename()` (the only sanctioned mass-mutation path for
 * dictKey fields) via the vault's `findAndUpdateReferences` callback.
 *
 * `registry` is `Vault#dictKeyFieldRegistry` (collection name → field name
 * → dictionary name); `getCollection` is the vault's collection accessor —
 * rewrites go through the public `coll.put()` choke point, same as before.
 */
export async function updateReferencingRecords(
  registry: ReadonlyMap<string, Record<string, string>>,
  getCollection: (collectionName: string) => DictReferencingCollection,
  name: string,
  oldKey: string,
  newKey: string,
): Promise<void> {
  for (const [collectionName, dictFields] of registry) {
    // Find fields that point at this dictionary
    const fields = Object.entries(dictFields)
      .filter(([, dn]) => dn === name)
      .map(([field]) => field)
    if (fields.length === 0) continue

    const coll = getCollection(collectionName)
    const records = await coll.list()
    for (const record of records) {
      let changed = false
      const updated = { ...record }
      for (const field of fields) {
        if (updated[field] === oldKey) {
          updated[field] = newKey
          changed = true
        }
      }
      if (changed) {
        const id = record['id'] as string | undefined
        if (id !== undefined) {
          await coll.put(id, updated)
        }
      }
    }
  }
}
