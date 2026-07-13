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
import type { FieldRef, ViaGraph } from '../../kernel/via-graph.js'
import type { StaticDictDescriptor } from '../../port/with/i18n-strategy.js'
import { dictCollectionName, type LookupHandle } from './handle.js'
import type { LookupDescriptor, OnDelete } from './descriptor.js'

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
 * An altKey candidate VALUE may be a string or number — both normalize via
 * `coerceLookupKey` (#651 Task 3); non-scalar/absent values are skipped.
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
      const value = coerceLookupKey(row[altField])
      if (value === undefined || value === '') continue
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
 * `dictKey()` doc comment made falsely). Matrix (collection) tier: sync —
 * delegates to `buildLookupAltIndex` so membership is checked against the
 * SAME `row[descriptor.key]` keying the altKey index uses (review fix,
 * Important 1: an earlier PUT-id `.get(key)` scan disagreed with the
 * altIndex whenever `descriptor.key !== 'id'`, wrongly rejecting valid
 * non-id candidates and wrongly accepting an unrelated row's PUT-id).
 */
export function checkLookupMembership(
  descriptor: LookupDescriptor,
  key: string,
  getDictionary: (dimension: string) => LookupHandle,
  getCollection: (dimension: string) => { querySourceForJoin(): JoinableSource },
): boolean {
  if (descriptor.backing === 'static') {
    const known = descriptor.keys ?? (descriptor.table ? Object.keys(descriptor.table) : [])
    return known.includes(key)
  }
  if (descriptor.backing === 'reserved') {
    if ((descriptor.keys ?? []).includes(key)) return true
    return getDictionary(descriptor.dimension).snapshotEntries().some((e) => e['key'] === key)
  }
  return buildLookupAltIndex(descriptor, getDictionary, getCollection).keys.has(key)
}

/**
 * The ONE guarded key coercion (#651 Task 3, dm12) — string/number values
 * coerce to their canonical `String()` form; everything else (`null`,
 * `undefined`, objects, …) coerces to `undefined`. Every consumer that turns
 * a raw record field into a lookup key routes through this, closing the
 * bare-`String()` `"undefined"`/`"null"`-key poisoning class (seam map
 * finding 6): a row whose key field is genuinely absent must never mint the
 * literal candidate string `"undefined"`.
 */
export function coerceLookupKey(raw: unknown): string | undefined {
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined
}

/**
 * Resolve a backing row's canonical key VALUE — `coerceLookupKey(row[descriptor.key])`
 * (#651 Task 3). The matrix tier's `row[descriptor.key]`, never the row's own PUT-id
 * when the two differ (`descriptor.key !== 'id'`).
 */
export function resolveBackingRowKey(
  descriptor: LookupDescriptor,
  row: Record<string, unknown>,
): string | undefined {
  return coerceLookupKey(row[descriptor.key])
}

/**
 * The referencing-side match predicate — does `rec[field]` (coerced) equal an
 * already-coerced `compareKey` (#651 Task 3)? Shared by every site that scans a
 * referencing collection for rows pointing at a given backing key
 * (`with-shape/links/vault-facade.ts`'s ref-delete propagation, `kernel/via-dispatch.ts`'s
 * forget-fanout twin).
 */
export function matchesReferencingValue(
  rec: Record<string, unknown>,
  field: string,
  compareKey: string,
): boolean {
  return coerceLookupKey(rec[field]) === compareKey
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
 * A matrix row whose `descriptor.key` field coerces to `undefined` (missing/
 * non-scalar) is SKIPPED — never enters the index under a poisoned
 * `"undefined"` key (#651 Task 3, dm12).
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
  const keyed = new Map<string, Record<string, unknown>>()
  for (const r of rows) {
    const row = r as Record<string, unknown>
    const key = resolveBackingRowKey(descriptor, row)
    if (key !== undefined) keyed.set(key, row)
  }
  return materializeBackingTable(descriptor, keyed)
}

/** One cross-collection `'ref'` graph edge a lookup field declares (#650 Task 5). Module-private —
 *  only `registerLookupRefEdges` below (the exported entry point) consumes it. */
interface LookupRefEdge {
  readonly referencing: FieldRef
  readonly sources: readonly FieldRef[]
  readonly onDelete: OnDelete
  /** The backing dimension's canonical-key FIELD NAME on its own row (`desc.key` — matrix tier
   *  only varies this; reserved/static tiers are always `'id'`). A referencing field always
   *  stores THIS field's value, never the backing row's PUT-id when the two differ. */
  readonly keyField: string
}

/**
 * Compute the cross-collection `'ref'` edges a collection's `lookupFields` declare (#650 Task 5,
 * spec §4) — one edge per non-static-backing field: target = the referencing field; sources =
 * the backing dimension's whole-collection node (`field:'*'`, the wildcard key
 * `ViaGraph.referencingEdgesOf` does its O(1) reverse lookup against) PLUS, when the descriptor
 * names a presentation field (`present.label`), that SPECIFIC field too. `foldPosture`'s
 * `DEFAULT_POSTURE` is the fold's identity element, so adding the wildcard alongside a real field
 * source changes nothing when that field is plain — but folds in a classified/money posture when
 * it isn't (taint composition, spec §4: "a lookup edge whose source names a classified field
 * contributes that field's posture"). Static tier (`backing:'static'`) has no backing collection/
 * dimension rows to reference-check — excluded. Pure; consumed only by `registerLookupRefEdges` below.
 */
function collectLookupRefEdges(
  collectionName: string,
  lookupFields: Record<string, LookupDescriptor> | undefined,
): readonly LookupRefEdge[] {
  const edges: LookupRefEdge[] = []
  for (const [field, desc] of Object.entries(lookupFields ?? {})) {
    if (desc.backing === 'static') continue
    const backing = desc.backing === 'reserved' ? dictCollectionName(desc.dimension) : desc.dimension
    edges.push({
      referencing: { collection: collectionName, field },
      sources: [
        { collection: backing, field: '*' },
        ...(desc.present?.label !== undefined ? [{ collection: backing, field: desc.present.label }] : []),
      ],
      onDelete: desc.onDelete,
      keyField: desc.key,
    })
  }
  return edges
}

/** Thin wrapper — `collectLookupRefEdges` + one `graph.registerDerived` call per edge. Lets
 *  `vault.collection()` (kernel-surface-budgeted, #650 Task 5) register a collection's lookup-ref
 *  edges with a single line, keeping the ceiling-guarded call site a thin call (route logic here). */
export function registerLookupRefEdges(
  graph: ViaGraph,
  collectionName: string,
  lookupFields: Record<string, LookupDescriptor> | undefined,
): void {
  for (const e of collectLookupRefEdges(collectionName, lookupFields)) {
    graph.registerDerived(e.referencing, e.sources, 'ref', 'record', e.onDelete, e.keyField)
  }
}

/**
 * `LookupViaConfig.snapshotFor`'s vault-built row source (#650 Task 6, spec
 * §5; matrix-tier coverage added #650 Task 7, spec §6 — Task 6 deferred it,
 * see `task-6-report.md`'s Concerns #1; the reviewer's Task-7 dispatch
 * refuted the "needs a new vault-resident registry" premise: the descriptor
 * is already in hand at both call sites, so `snapshotFor` just needs to
 * ACCEPT it). Takes the full `descriptor` (not a bare dimension name) so it
 * can route the matrix tier's `key` field, which — unlike reserved tier's
 * hardcoded `'id'` — varies per collection. Routes on `descriptor.backing`:
 *
 * - **reserved**: rows come straight from the SAME `LookupHandle.
 *   snapshotEntries()` write-through cache `dictLabelResolver`/
 *   `resolveDictSource` already read (no second copy), keyed by each
 *   entry's own canonical `key` (always `'id'` by construction for this
 *   tier — `dict()`'s factory hardcodes it).
 * - **collection** (matrix): rows come from `getCollection(dimension).
 *   querySourceForJoin().snapshot()` — the SAME sync, already-live cache
 *   `buildLookupAltIndex`'s matrix branch (above, this file) and `.join()`
 *   itself already read — re-keyed via `resolveBackingRowKey(descriptor, row)`,
 *   NOT the row's own PUT-id (which may differ when `key !== 'id'`; the exact
 *   distinction the #650 Task 3 review fix already applies to
 *   `checkLookupMembership`'s matrix branch). A row whose `descriptor.key`
 *   field coerces to `undefined` is skipped (#651 Task 3, dm12).
 * - **static**: never routed here — `descriptor.table` is read directly by
 *   the caller (`binding.ts`'s `compareLookupOrder`/`resolveLookupOrderLabel`,
 *   `snapshot.ts`'s `presentLookupForJoin`); no vault call needed.
 *
 * `isReservedDimension` is the vault's `reservedLookupCollections`
 * membership test.
 */
export function buildLookupSnapshotRows(
  descriptor: LookupDescriptor,
  isReservedDimension: (dimension: string) => boolean,
  getDictionary: (dimension: string) => LookupHandle,
  getCollection: (dimension: string) => { querySourceForJoin(): JoinableSource },
): ReadonlyMap<string, Record<string, unknown>> | undefined {
  const dimension = descriptor.dimension
  if (isReservedDimension(dimension)) {
    const rows = new Map<string, Record<string, unknown>>()
    for (const entry of getDictionary(dimension).snapshotEntries()) {
      const key = entry['key']
      if (typeof key === 'string') rows.set(key, entry)
    }
    return rows
  }
  if (descriptor.backing === 'collection') {
    const rawRows = getCollection(dimension).querySourceForJoin().snapshot()
    const rows = new Map<string, Record<string, unknown>>()
    for (const r of rawRows) {
      const row = r as Record<string, unknown>
      const key = resolveBackingRowKey(descriptor, row)
      if (key !== undefined) rows.set(key, row)
    }
    return rows
  }
  return undefined
}
