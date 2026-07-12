/**
 * The `'lookup'` `ViaBinding` — wires the lookup engine (present-time label
 * dressing across all three backing tiers) into the kernel's generic Via
 * port. Mirrors `shape/via-i18n/binding.ts`'s #553 static-link pattern; the
 * present-time label-dressing algorithm below is adapted from
 * `via-i18n/binding.ts:253-337` (the same wildcard/array/scalar handling,
 * the same `onMissing`/`substitute` policy engine), generalized to branch on
 * `backing` instead of a static-vs-dynamic descriptor-shape check. For the
 * `'static'` and `'reserved'` tiers this delegates to `cfg.lookupLabelResolver`
 * — the SAME vault-built closure the i18n binding's `dictLabelResolver` uses
 * (static table first, else the `vault.dictionary()` handle) — so a native
 * `dict()`/`lookup(static)` field resolves through the identical label data
 * as its `dictKey()`/`staticDict()` alias (the byte-equivalence lock).
 *
 * `lookup()`/`enumOf()`/`dict()` each call {@link linkLookupVia} first — the
 * same #553 pattern `money()`/`dictKey()` use.
 *
 * `buildClause` (label-predicate queries) is still undeclared — out of scope
 * for #650. `compareForOrder` (#650 Task 6, spec §5; matrix tier added Task
 * 7) resolves a `sortBy`-declared field's ordering via `cfg.snapshotFor`'s
 * sync snapshot; the hook signature is UNCHANGED (`via.ts:128-129` — no
 * locale param), so it closes over each descriptor's own `displayLocale`
 * (the same locale-less-hinge default `runLookupPresent`'s
 * `hasStaticDisplay` branch already uses). `resolveOrderLabel` (#650 Task
 * 7) is the PER-CALL-locale sibling `orderBy(..., {by:'label'})` needs —
 * see its own doc comment below. `describeFragment` (#650 Task 7) is the
 * first-ever consumed `ViaBinding.describeFragment` implementation — see
 * `with-shape/introspection/describe.ts`'s `buildDescription`.
 */
import type { ViaBinding, ViaReadCtx } from '../../kernel/via.js'
import { installViaBinder } from '../../kernel/via.js'
import type { LookupDescriptor, LookupBacking, Vocabulary, OnDelete } from './descriptor.js'
import { resolvePolicy, type Layer } from '../via-i18n/policy.js'
import { LocaleNotSpecifiedError, UnknownLookupKeyError, ValidationError } from '../../kernel/errors.js'
import { getAtPath, setAtPathInPlace } from '../../kernel/paths.js'
import type { MaterializedBacking } from './registry.js'
import { buildLookupSnapshot } from './snapshot.js'

/**
 * Config a collection's lookup declarations resolve to — the binding's
 * construction input. `lookupLabelResolver`/`getLookupBacking`/`membership`/
 * `snapshotFor` are vault-built closures (never a `Collection` handle,
 * keyring, or DEK/CEK — the zero-knowledge boundary).
 */
export interface LookupViaConfig {
  readonly lookupFields: Record<string, LookupDescriptor>
  readonly lookupLabelResolver?: (dimension: string, key: string, locale: string, fallback?: unknown) => Promise<string | undefined>
  /**
   * The matrix (collection) tier's present-time backing-row source, keyed by the full
   * descriptor (not a bare dimension name) so the closure can resolve by `descriptor.key`,
   * not the backing row's PUT-id (#651 Task 3 — the same descriptor-gaining dispatch Task 7
   * already applied to `snapshotFor`).
   */
  readonly getLookupBacking?: (descriptor: LookupDescriptor) => (key: string) => Promise<Record<string, unknown> | undefined>
  /** Closed-vocabulary write-time membership test (#650 Task 3) — `(field, key) => known?`. */
  readonly membership?: (field: string, key: string) => boolean | Promise<boolean>
  /** Sync per-descriptor altKey index — `ingest`'s normalization source (#650 Task 3). */
  readonly getAltIndex?: (desc: LookupDescriptor) => MaterializedBacking | undefined
  /**
   * Sync materialized `key -> row` rows for a lookup descriptor (#650 Task
   * 6, spec §5; matrix-tier routing added #650 Task 7) — `compareForOrder`
   * and `resolveOrderLabel` below, and `snapshot.ts`'s `presentForJoin`
   * builder, all read this same vault-built closure. Reserved AND
   * collection (matrix) tier route here (the vault wires
   * `dimension -> LookupHandle.snapshotEntries()` / `dimension ->
   * collection.querySourceForJoin().snapshot()` respectively, keyed by
   * `descriptor.key` for the matrix case — see `registry.ts`'s
   * `buildLookupSnapshotRows`); static tier is resolved locally from
   * `descriptor.table` without calling this.
   */
  readonly snapshotFor?: (descriptor: LookupDescriptor) => ReadonlyMap<string, Record<string, unknown>> | undefined
  readonly collectionName: string
}

/** Enum tier (`backing:'static'`, no `table`) has no label source at all — never dressed. */
function hasLabelSource(desc: LookupDescriptor): boolean {
  return !(desc.backing === 'static' && desc.table === undefined)
}

/**
 * Resolve one key's label. `'static'`/`'reserved'` both go through
 * `cfg.lookupLabelResolver` (mirrors `dictLabelResolver`'s own static-table-
 * first-else-reserved-handle branching — the SAME closure is reused, see
 * `kernel/vault.ts`). `'collection'` (matrix tier) reads the declared
 * `present.label` off the backing row via `cfg.getLookupBacking`; when
 * `present.by` is set, that field's value is a `{ locale -> label }` map
 * indexed by the effective locale.
 */
async function fetchLookupLabel(
  desc: LookupDescriptor,
  key: string,
  effLocale: string,
  fieldFallback: string | readonly string[] | undefined,
  cfg: LookupViaConfig,
): Promise<string | undefined> {
  if (desc.backing === 'collection') {
    const getRow = cfg.getLookupBacking?.(desc)
    const row = getRow ? await getRow(key) : undefined
    const labelField = desc.present?.label
    if (!row || labelField === undefined) return undefined
    const raw = row[labelField]
    if (desc.present?.by !== undefined) {
      return raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[effLocale] as string | undefined : undefined
    }
    return typeof raw === 'string' ? raw : undefined
  }
  return cfg.lookupLabelResolver?.(desc.dimension, key, effLocale, fieldFallback)
}

/** `present` — resolve `<field>Label` for every declared lookup field. Adapted from `via-i18n/binding.ts:253-337`. */
async function runLookupPresent(
  record: Record<string, unknown>,
  ctx: ViaReadCtx,
  cfg: LookupViaConfig,
): Promise<Record<string, unknown>> {
  const fields = Object.entries(cfg.lookupFields).filter(([, d]) => hasLabelSource(d))
  if (fields.length === 0) return record

  const locale = typeof ctx.locale === 'string' ? ctx.locale : undefined
  const fallback = ctx.fallback as string | readonly string[] | undefined
  const layer = ctx.layer as Layer

  // `{ locale: 'raw' }` wants the untouched record — mirrors
  // `via-i18n/binding.ts`'s `locale !== 'raw'` dict-label gate exactly (no
  // synthetic `<field>Label` derivative on a raw read).
  if (locale === 'raw') return record

  // Static-display hybrid hinge: a `backing:'static'` field with a declared
  // `displayLocale` resolves its `<field>Label` even under a locale-less
  // read (mirrors staticDict's `hasStaticDisplay` gate).
  const hasStaticDisplay = fields.some(([, d]) => d.backing === 'static' && d.displayLocale !== undefined)
  if (!locale && !hasStaticDisplay) return record

  let result = record
  const withLabels = { ...result }

  for (const [field, desc] of fields) {
    const policy = desc.onMissing ? resolvePolicy(desc.onMissing, layer) : 'null'
    const fieldFallback = policy === 'substitute' ? (fallback ?? desc.substitute) : fallback
    const effLocale = locale ?? (desc.backing === 'static' ? desc.displayLocale : undefined)

    const resolveKey = async (key: string): Promise<string | null> => {
      if (!effLocale) {
        if (policy === 'throw') {
          throw new LocaleNotSpecifiedError(field, `lookup "${field}": no locale active to resolve key "${key}".`)
        }
        return null
      }
      const label = await fetchLookupLabel(desc, key, effLocale, fieldFallback, cfg)
      if (label === undefined) {
        if (policy === 'throw') {
          throw new LocaleNotSpecifiedError(field, `lookup "${field}": no label for key "${key}" in locale "${effLocale}".`)
        }
        return null
      }
      return label
    }

    if (field.includes('[].')) {
      const parts = field.split('[].')
      const arrayKey = parts[0]!
      const leaf = parts[1]
      if (!leaf || leaf.includes('.')) continue
      const arr = (withLabels as Record<string, unknown>)[arrayKey]
      if (!Array.isArray(arr)) continue
      const labelKey = `${leaf}Label`
      ;(withLabels as Record<string, unknown>)[arrayKey] = await Promise.all(
        arr.map(async (el) => {
          if (!el || typeof el !== 'object' || Array.isArray(el)) return el
          const k = (el as Record<string, unknown>)[leaf]
          if (typeof k !== 'string') return el
          return { ...(el as Record<string, unknown>), [labelKey]: await resolveKey(k) }
        }),
      )
      continue
    }

    const val = result[field]
    if (Array.isArray(val)) {
      withLabels[`${field}Label`] = await Promise.all(
        val.map(async (k) => ({ key: k, label: typeof k === 'string' ? await resolveKey(k) : null })),
      )
    } else if (typeof val === 'string') {
      const label = await resolveKey(val)
      if (label !== null) withLabels[`${field}Label`] = label
    }
  }

  result = withLabels
  return result
}

/**
 * One field's `lookup` descriptor as it appears on a `ViaBinding.
 * describeFragment()` payload (#650 Task 7 — the first real consumer,
 * `with-shape/introspection/describe.ts`'s `buildDescription`, imports this
 * type directly; `describe.ts` is NOT under `kernel/**`, so it's free to
 * import concrete shape/ types the way it already does for
 * `LookupDescriptor`/`MoneyDescriptor`/etc.). `dimension` is OMITTED (not
 * emitted as `''`) for a bare `enumOf()` descriptor — the #650 Task 2
 * `dimension:''` sentinel resolved: no dimension name means no `dimension`
 * key, not a meaningless empty string (T2 carry, #650 Task 7).
 */
export interface LookupDescribeFragmentEntry {
  readonly dimension?: string
  readonly backing: LookupBacking
  readonly vocabulary: Vocabulary
  readonly key: string
  readonly altKeys?: readonly string[]
  readonly present?: { readonly label: string; readonly by?: string }
  readonly sortBy?: string
  readonly onDelete: OnDelete
  /** Statically-known closed-vocabulary key set (declared `keys`, or a static table's own keys). Omitted when membership lives only in the backing collection/dictionary (open vocabulary, or closed with no declared `keys`). */
  readonly keys?: readonly string[]
}

/** The `'lookup'` binding's `describeFragment()` payload shape. */
export interface LookupDescribeFragment {
  readonly lookupFields: Record<string, LookupDescribeFragmentEntry>
}

function buildLookupDescribeFragment(cfg: LookupViaConfig): Record<string, unknown> {
  const lookupFields: Record<string, LookupDescribeFragmentEntry> = {}
  for (const [field, desc] of Object.entries(cfg.lookupFields)) {
    lookupFields[field] = {
      ...(desc.dimension !== '' ? { dimension: desc.dimension } : {}),
      backing: desc.backing,
      vocabulary: desc.vocabulary,
      key: desc.key,
      onDelete: desc.onDelete,
      ...(desc.altKeys !== undefined ? { altKeys: desc.altKeys } : {}),
      ...(desc.present !== undefined ? { present: desc.present } : {}),
      ...(desc.sortBy !== undefined ? { sortBy: desc.sortBy } : {}),
      ...(desc.keys !== undefined ? { keys: desc.keys } : {}),
    }
  }
  return { lookupFields }
}

/**
 * `cfg.getAltIndex(desc)` (matrix tier) reads the backing collection's cache
 * via `querySourceForJoin()` (`buildLookupAltIndex`, registry.ts) — which
 * throws a `.join()`-branded message when that collection was opened
 * `{prefetch:false}` (lazy mode is unsupported for altKey normalization).
 * Normalization must never silently not happen (the banned silent-no-op
 * class, #650 Task 3 review, Important 2) — detect that specific failure
 * and surface a CLEAR, lookup-branded `ValidationError` at the point of
 * failure instead of letting the confusing join-branded one leak onto an
 * unrelated `put()`. Any OTHER error (e.g. `materializeBackingTable`'s own
 * altKey-collision `ValidationError`) propagates unchanged.
 */
function getAltIndexOrThrow(field: string, desc: LookupDescriptor, cfg: LookupViaConfig): MaterializedBacking | undefined {
  try {
    return cfg.getAltIndex?.(desc)
  } catch (err) {
    if (err instanceof Error && err.message.includes('lazy-mode')) {
      throw new ValidationError(
        `lookup: altKeys on "${field}" require the backing collection "${desc.dimension}" to be ` +
          `prefetch-enabled (lazy mode unsupported); open it without {prefetch:false} or drop altKeys.`,
      )
    }
    throw err
  }
}

/**
 * `ingest` — altKey candidate values normalize to the canonical key (#650
 * Task 3, spec §3). Pure, sync, idempotent (a canonical key maps to
 * itself); no store read — consults the pre-materialized
 * `cfg.getAltIndex(desc)`. The money `canonicalizeIncomingMoney` precedent
 * (`via.ts:108`).
 *
 * A `[].`-wildcard multi-value path (`getAtPath` resolves >1 entries — an
 * array of nested objects, e.g. `'lines[].country'`, the same wildcard
 * convention `runLookupPresent` above already handles) normalizes EVERY
 * element's leaf value, not just a lone scalar (#652 fix — this used to bail
 * out entirely here while `runLookupEnforceWrite` below validated every
 * value unnormalized, so a legitimate altKey in an array position was
 * wrongly refused by closed-vocabulary enforcement). `setAtPathInPlace`
 * can't write into a `[].`-wildcard path, so the array is reconstructed
 * immutably instead, mirroring `runLookupPresent`'s own `field.includes
 * ('[].')` branch. A plain field whose OWN value is a bare array (not a
 * `[].`-wildcard path) is a different, untouched shape — `getAtPath`
 * resolves it to one opaque value, so it still falls through the
 * `values.length !== 1` / `typeof value !== 'string'` checks below unchanged.
 */
function runLookupIngest(record: Record<string, unknown>, cfg: LookupViaConfig): Record<string, unknown> {
  const withAltKeys = Object.entries(cfg.lookupFields).filter(([, d]) => (d.altKeys?.length ?? 0) > 0)
  if (withAltKeys.length === 0) return record

  let result = record
  for (const [field, desc] of withAltKeys) {
    const backing = getAltIndexOrThrow(field, desc, cfg)
    if (!backing || backing.altIndex.size === 0) continue

    if (field.includes('[].')) {
      const [arrayKey, leaf] = field.split('[].')
      if (!leaf || leaf.includes('.')) continue
      const arr = record[arrayKey!]
      if (!Array.isArray(arr)) continue
      let changed = false
      const normalized = arr.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item
        const value = (item as Record<string, unknown>)[leaf]
        if (typeof value !== 'string') return item
        const canonical = backing.altIndex.get(value)
        if (canonical === undefined || canonical === value) return item
        changed = true
        return { ...(item as Record<string, unknown>), [leaf]: canonical }
      })
      if (!changed) continue
      if (result === record) result = { ...record }
      result[arrayKey!] = normalized
      continue
    }

    const values = getAtPath(record, field)
    if (values.length !== 1) continue
    const value = values[0]
    if (typeof value !== 'string') continue
    const canonical = backing.altIndex.get(value)
    if (canonical === undefined || canonical === value) continue
    if (result === record) result = { ...record }
    setAtPathInPlace(result, field, canonical)
  }
  return result
}

/**
 * `enforceWrite` — closed-vocabulary write refusal (#650 Task 3, spec §3).
 * Runs only for `vocabulary:'closed'` fields; `'open'` (the dictKey/dict
 * default) skips the check entirely, so #649's fix is additive — existing
 * dictKey/staticDict collections are unaffected. `ctx` carries no
 * cross-collection door (`id`/`vault`/`prior`/`emit` only, unchanged) —
 * membership is a vault-built closure on `cfg`, per spec.
 */
async function runLookupEnforceWrite(record: Record<string, unknown>, cfg: LookupViaConfig): Promise<void> {
  for (const [field, desc] of Object.entries(cfg.lookupFields)) {
    if (desc.vocabulary !== 'closed') continue
    // Checks every value `getAtPath` returns — for a `[].`-wildcard
    // multi-value path, that's every element's leaf value.
    // `runLookupIngest` above now normalizes each of those elements first
    // (#652), so what lands here for a `[].`-wildcard field is already
    // canonical; this loop's job stays membership, not normalization.
    for (const value of getAtPath(record, field)) {
      if (typeof value !== 'string') continue
      const known = cfg.membership ? await cfg.membership(field, value) : true
      if (!known) throw new UnknownLookupKeyError(desc.dimension, field, value)
    }
  }
}

/**
 * `compareForOrder` — exact ordering for a `sortBy`-declared lookup field
 * against the sync snapshot (#650 Task 6, spec §5, conflict resolution 4;
 * matrix-tier coverage added #650 Task 7). Opt-in: undeclared `sortBy`
 * (every dictKey/staticDict alias and every lookup field declared before
 * Task 6) returns `undefined` — falls through to the generic stored-value
 * comparator, byte-identical to today. Static tier reads `descriptor.table`
 * directly; reserved AND matrix (collection) tier both read `cfg.snapshotFor`
 * (the SAME live cache `presentForJoin`'s lookup half reads — see
 * `snapshot.ts`'s file header). The hook has no locale parameter
 * (`via.ts:128-129`, unchanged) — closes over the descriptor's own
 * `displayLocale` (the same locale-less-hinge default `runLookupPresent`
 * already uses); a `sortBy` field whose value isn't locale-keyed
 * (`present.by` undefined) never needs one. A `by`-keyed `sortBy` field
 * with NO declared `displayLocale` degrades to comparing the raw canonical
 * keys (silent — `LookupSnapshot.compareKeys` never throws; declare-time
 * warning at `descriptor.ts`'s `lookup()` factory; use
 * `orderBy(field, dir, {by:'label'})` — `resolveOrderLabel` below — for a
 * PER-CALL locale instead).
 */
function compareLookupOrder(field: string, a: unknown, b: unknown, cfg: LookupViaConfig): number | undefined {
  if (typeof a !== 'string' || typeof b !== 'string') return undefined
  const desc = cfg.lookupFields[field]
  if (!desc || desc.sortBy === undefined) return undefined
  const rows = desc.backing === 'static'
    ? (desc.table ? new Map(Object.entries(desc.table)) : undefined)
    : cfg.snapshotFor?.(desc)
  if (!rows) return undefined
  return buildLookupSnapshot(desc.dimension, rows, desc).compareKeys(a, b, desc.displayLocale ?? '')
}

/**
 * `resolveOrderLabel` — per-key, PER-CALL-locale label resolution for
 * `orderBy(field, dir, { by: 'label' })` (#650 Task 7, spec §6 / seam map
 * Part 10 surprise 6's option (b)) — the channel `compareForOrder` above
 * structurally cannot serve, since `ViaBinding.compareForOrder` carries no
 * locale parameter. Consumed by `kernel/query/builder.ts`'s
 * `buildOrderLabelMaps` as the fallback for lookup fields the legacy dict
 * registries don't bridge (matrix tier; reserved/static tier already
 * resolves via that bridge — `JoinContext.resolveDictSource` — tried
 * FIRST by the caller, see `registry.ts`'s `collectLookupDictCompat` doc
 * comment). Reuses the exact same `cfg.snapshotFor`/`buildLookupSnapshot`
 * machinery as `compareLookupOrder` above, just with the per-call `locale`
 * in place of the descriptor's own `displayLocale` — falling back to
 * `displayLocale` only when the call itself is locale-less, the same
 * hinge order `runLookupPresent` already uses.
 */
function resolveLookupOrderLabel(field: string, key: string, locale: string | undefined, cfg: LookupViaConfig): string | undefined {
  const desc = cfg.lookupFields[field]
  if (!desc) return undefined
  const rows = desc.backing === 'static'
    ? (desc.table ? new Map(Object.entries(desc.table)) : undefined)
    : cfg.snapshotFor?.(desc)
  if (!rows) return undefined
  return buildLookupSnapshot(desc.dimension, rows, desc).label(key, locale ?? desc.displayLocale ?? '')
}

export function lookupBinding(cfg: LookupViaConfig): ViaBinding {
  return {
    brand: 'lookup',
    posture: { encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: false },
    reservedPrefixes: ['_dict_', '_lookup_'],
    covers: (field) => field in cfg.lookupFields,
    ingest: (record) => runLookupIngest(record, cfg),
    enforceWrite: (record) => runLookupEnforceWrite(record, cfg),
    present: async (record, ctx) => runLookupPresent(record, ctx, cfg),
    compareForOrder: (field, a, b) => compareLookupOrder(field, a, b, cfg),
    resolveOrderLabel: (field, key, locale) => resolveLookupOrderLabel(field, key, locale, cfg),
    describeFragment: () => buildLookupDescribeFragment(cfg),
  }
}

export function linkLookupVia(): void {
  installViaBinder('lookup', (c) => lookupBinding(c as LookupViaConfig))
}
