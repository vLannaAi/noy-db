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
import { UnknownDictCodeError, ValidationError } from '../../kernel/errors.js'
import type { JoinableSource } from '../../kernel/query/index.js'
import type { StaticDictDescriptor } from '../../port/with/i18n-strategy.js'
import type { LookupHandle } from './handle.js'
import type { LookupDescriptor } from './descriptor.js'

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

/**
 * Resolve a label from an in-memory `{ locale -> label }` map, walking the
 * same fallback chain semantics as `LookupHandle.resolveLabel` (#650 Task 2
 * — moved here from `kernel/vault.ts` so the SAME chain serves both the
 * i18n binding's `dictLabelResolver` and the lookup binding's
 * `lookupLabelResolver`, which #650 Task 2 wires to the identical closure).
 */
export function resolveLabelFromMap(
  labels: Readonly<Record<string, string>>,
  locale: string,
  fallback?: string | readonly string[],
): string | undefined {
  if (labels[locale] !== undefined) return labels[locale]
  const chain = Array.isArray(fallback)
    ? (fallback as readonly string[])
    : fallback
      ? [fallback as string]
      : []
  for (const fb of chain) {
    if (fb === 'any') {
      const any = Object.values(labels)[0]
      if (any !== undefined) return any
    } else if (labels[fb] !== undefined) {
      return labels[fb]
    }
  }
  return undefined
}

/**
 * Project a native `lookup(dimension, { backing:'static', table, … })`
 * descriptor into the legacy `StaticDictDescriptor` shape — the
 * alias-equivalence compat seam (#650 Task 2) that lets a native
 * static-tier lookup field reuse the SAME vault registries
 * (`staticByName`/`staticDescriptorByField`) — and therefore the same
 * `dictLabelResolver`/`resolveDictSource` machinery — as its `staticDict()`
 * alias. `vocabulary:'closed'` maps to `validateCodes:true` (closed = only
 * declared codes are legal); `'open'` maps to `validateCodes:false`.
 * Returns `undefined` for non-static or table-less (bare `enumOf`)
 * descriptors — those have nothing to register.
 */
export function lookupToStaticDictCompat(desc: LookupDescriptor): StaticDictDescriptor | undefined {
  if (desc.backing !== 'static' || desc.table === undefined) return undefined
  return {
    _noydbStaticDict: true,
    _viaBrand: 'i18n',
    name: desc.dimension,
    table: desc.table,
    keys: desc.keys ?? Object.keys(desc.table),
    ...(desc.displayLocale !== undefined ? { displayLocale: desc.displayLocale } : {}),
    ...(desc.onMissing !== undefined ? { onMissing: desc.onMissing } : {}),
    ...(desc.substitute !== undefined ? { substitute: desc.substitute } : {}),
    validateCodes: desc.vocabulary === 'closed',
  }
}

/** The vault-registry entries a collection's `lookupFields` contribute — the alias-equivalence bridge (#650 Task 2). */
export interface LookupDictCompat {
  /** Reserved-tier fields: field name -> dimension (dictionary) name — merges into `dictKeyFieldRegistry`. */
  readonly dictFieldMap: Record<string, string>
  /** Static-tier (table-bearing) fields, projected — merges into `staticDescriptorByField`/`staticByName`. */
  readonly staticEntries: ReadonlyArray<readonly [string, StaticDictDescriptor]>
}

/**
 * Bridge a collection's `lookupFields` into the SAME shape the legacy dict
 * registries expect, so `resolveDictSource`/`dictLabelResolver` (and
 * therefore `.join()`/`orderBy({by:'label'})`) serve a native `dict()`/
 * `lookup(static)` field identically to its `dictKey()`/`staticDict()`
 * alias — the reserved-vs-first-class-backing "matrix" tier is NOT bridged
 * here (no vault registry backs it; Task 5/6 build its own graph edge /
 * snapshot seam).
 */
export function collectLookupDictCompat(
  lookupFields: Record<string, LookupDescriptor> | undefined,
): LookupDictCompat {
  const dictFieldMap: Record<string, string> = {}
  const staticEntries: Array<readonly [string, StaticDictDescriptor]> = []
  for (const [field, desc] of Object.entries(lookupFields ?? {})) {
    if (desc.backing === 'reserved') {
      dictFieldMap[field] = desc.dimension
    } else {
      const compat = lookupToStaticDictCompat(desc)
      if (compat) staticEntries.push([field, compat])
    }
  }
  return { dictFieldMap, staticEntries }
}

/**
 * A lookup dimension's sync membership/altKey table, materialized from its
 * backing rows (#650 Task 3). `keys` is every canonical key present;
 * `altIndex` maps an altKey candidate VALUE to its owning canonical key.
 */
export interface MaterializedBacking {
  /** Canonical key values present in the materialized rows. */
  readonly keys: ReadonlySet<string>
  /** altKey candidate value -> canonical key. */
  readonly altIndex: ReadonlyMap<string, string>
}

/**
 * Build a lookup dimension's altKey index from its backing rows, enforcing
 * declare/warm-time uniqueness across `key ∪ altKeys` values (#650 Task 3 —
 * the CHE/SWZ drift class: two different rows must never claim the same
 * candidate key). `rows` is keyed by canonical key (`row[descriptor.key]`
 * for the matrix tier; the dimension's own key for static/reserved).
 * Pure — no I/O. Throws `ValidationError` on collision.
 */
export function materializeBackingTable(
  descriptor: LookupDescriptor,
  rows: ReadonlyMap<string, Record<string, unknown>>,
): MaterializedBacking {
  const keys = new Set<string>(rows.keys())
  // Every value that has claimed ownership so far (canonical keys seed it) —
  // the union `key ∪ altKeys` uniqueness set the spec requires.
  const owner = new Map<string, string>()
  for (const key of keys) owner.set(key, key)

  const altIndex = new Map<string, string>()
  const altFields = descriptor.altKeys ?? []
  for (const [canonicalKey, row] of rows) {
    for (const altField of altFields) {
      const value = row[altField]
      if (typeof value !== 'string' || value === '') continue
      const existingOwner = owner.get(value)
      if (existingOwner !== undefined && existingOwner !== canonicalKey) {
        throw new ValidationError(
          `lookup "${descriptor.dimension}": altKey field "${altField}" value "${value}" is claimed by ` +
            `both "${existingOwner}" and "${canonicalKey}" — key/altKey values must be unique across the dimension.`,
        )
      }
      owner.set(value, canonicalKey)
      altIndex.set(value, canonicalKey)
    }
  }
  return { keys, altIndex }
}

/**
 * Closed-vocabulary membership test for one candidate key (#650 Task 3).
 * Static tier: sync, against the in-config key set (declared `keys`, or the
 * table's own keys when table-bearing). Reserved tier: sync — the declared
 * `keys` union the reserved handle's live write-through snapshot (closes
 * #649 for the native `dict()` spelling: the declared-keys promise the old
 * `dictKey()` doc comment made falsely). Matrix (collection) tier: awaits a
 * targeted `get(key)` on the backing collection — the `enforceRefsOnPut`
 * async precedent (`with-shape/links/vault-facade.ts:113`).
 */
export function checkLookupMembership(
  descriptor: LookupDescriptor,
  key: string,
  getDictionary: (dimension: string) => LookupHandle,
  getCollection: (dimension: string) => { get(id: string): Promise<unknown> },
): boolean | Promise<boolean> {
  if (descriptor.backing === 'static') {
    const known = descriptor.keys ?? (descriptor.table ? Object.keys(descriptor.table) : [])
    return known.includes(key)
  }
  if (descriptor.backing === 'reserved') {
    if ((descriptor.keys ?? []).includes(key)) return true
    return getDictionary(descriptor.dimension).snapshotEntries().some((e) => e['key'] === key)
  }
  return getCollection(descriptor.dimension)
    .get(key)
    .then((row) => row !== undefined && row !== null)
}

/**
 * Materialize a lookup dimension's altKey index from whatever backing data
 * is synchronously available (#650 Task 3 — the `ingest` source). Static:
 * the in-config table. Reserved: the reserved handle's live write-through
 * cache (the same warm-via-put()/list() cache `resolveDictSource` already
 * relies on). Matrix (collection): the backing collection's own in-memory
 * eager cache via `querySourceForJoin()` — already public, already the
 * mechanism `.join()` uses (`with-shape/links/vault-facade.ts`'s
 * `resolveSource`); no new I/O, no fire-and-forget warm step. Like that
 * existing join precedent, a dimension collection this vault session has
 * not yet opened/populated sees an empty snapshot (no altKey normalization
 * until it has rows) — open/populate it first for normalization to apply.
 */
export function buildLookupAltIndex(
  descriptor: LookupDescriptor,
  getDictionary: (dimension: string) => LookupHandle,
  getCollection: (dimension: string) => { querySourceForJoin(): JoinableSource },
): MaterializedBacking {
  if (descriptor.backing === 'static') {
    return materializeBackingTable(descriptor, new Map(Object.entries(descriptor.table ?? {})))
  }
  if (descriptor.backing === 'reserved') {
    const entries = getDictionary(descriptor.dimension).snapshotEntries()
    return materializeBackingTable(descriptor, new Map(entries.map((e) => [String(e['key']), e])))
  }
  const rows = getCollection(descriptor.dimension).querySourceForJoin().snapshot()
  return materializeBackingTable(
    descriptor,
    new Map(
      rows.map((r) => {
        const row = r as Record<string, unknown>
        return [String(row[descriptor.key]), row] as const
      }),
    ),
  )
}
