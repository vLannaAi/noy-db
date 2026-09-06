/**
 * The sync lookup snapshot + join/locale seam (#650 Task 6, spec §5 — "the
 * snapshot+locale seam"). Retires the #626 kernel→via grandfather:
 * `kernel/query/relate/join.ts` no longer imports `via/i18n/core.js` directly
 * — it calls the `presentForJoin` hook this file's `buildPresentForJoin`
 * builds instead (seam map Part 2 item 4, the #626 reviewer-spec'd shape:
 * a sync `presentI18nForJoin`-class hook on `JoinableSource`).
 *
 * `LookupSnapshot` is the sync materialized `key -> row` view over ONE
 * lookup dimension's ALREADY-LIVE backing data (the `active.ts`
 * `_syncCache`/`snapshotEntries` write-through-cache pattern — never a
 * second copy of the data: `LookupViaConfig.snapshotFor`'s vault-built
 * closure reads the SAME `LookupHandle._syncCache` /
 * first-class-collection cache every other lookup consumer
 * (`dictLabelResolver`, `resolveDictSource`, `getAltIndex`) already reads).
 * Serves (reserved AND matrix tier since #650 Task 7 — `registry.ts`'s
 * `buildLookupSnapshotRows` routes both; static tier is read straight off
 * `descriptor.table` by every consumer below, never through this cache):
 *   - join dressing (`presentForJoin`, consumed by `kernel/query/relate/join.ts`
 *     via `JoinableSource.presentForJoin`)
 *   - dimension sort (`compareForOrder`, consumed by
 *     `via/lookup/binding.ts`'s `NoydbVia.compareForOrder` closure)
 *   - per-call-locale order-label resolution (`resolveOrderLabel`, #650
 *     Task 7 — the `orderBy(..., {by:'label'})` channel `compareForOrder`
 *     structurally can't serve, no locale param; consumed by
 *     `kernel/query/builder.ts`'s `buildOrderLabelMaps`)
 *   - membership: reserved/static-tier membership (#650 Task 3,
 *     `checkLookupMembership`) already reads the identical sync caches
 *     directly — not re-plumbed through this file; see
 *     `.superpowers/sdd/task-6-report.md`'s "bridge disposition" section.
 *
 * Sync end-to-end (#553) — every function here is a pure, synchronous
 * transform over already-materialized rows; no store read, no Promise.
 */
import type { LookupDescriptor } from './descriptor.js'
import { presentI18nForJoin, type I18nTextDescriptor } from '../i18n/core.js'

/** A lookup dimension's sync materialized view — see file header. */
export interface LookupSnapshot {
  /** The full backing row for `key`, or `undefined` when `key` isn't (yet) present in the snapshot. */
  row(key: string): Record<string, unknown> | undefined
  /** The dimension's declared presentation label for `key` at `locale` — mirrors `binding.ts`'s `fetchLookupLabel` (matrix-row branch), generalized to any tier's already-materialized rows. */
  label(key: string, locale: string, fallback?: unknown): string | undefined
  /**
   * Exact ordering for two canonical keys against `descriptor.sortBy`
   * (falls back to `present.label`, then to the raw keys) at `locale`.
   * Never throws — degrades to comparing the raw keys when no sortable
   * value resolves for either side.
   */
  compareKeys(a: string, b: string, locale: string): number
}

/** Read one row field, resolving a `by`-keyed (locale-map) value when `by` is declared. */
function readRowField(
  row: Record<string, unknown> | undefined,
  field: string | undefined,
  by: string | undefined,
  locale: string,
  fallback?: unknown,
): string | undefined {
  if (!row || field === undefined) return undefined
  const raw = row[field]
  if (by === undefined) return typeof raw === 'string' ? raw : undefined
  if (!raw || typeof raw !== 'object') return undefined
  const map = raw as Record<string, unknown>
  const val = map[locale]
  if (typeof val === 'string') return val
  if (typeof fallback === 'string' && typeof map[fallback] === 'string') return map[fallback]
  return undefined
}

/**
 * Build a sync `LookupSnapshot` over one dimension's already-materialized
 * rows (canonical-key -> row, the SAME keying `materializeBackingTable`
 * (`registry.ts`, #650 Task 3) uses). Pure — never reads a store.
 */
export function buildLookupSnapshot(
  dimension: string,
  rows: ReadonlyMap<string, Record<string, unknown>>,
  descriptor: LookupDescriptor,
): LookupSnapshot {
  void dimension // identity only — kept for parity with materializeBackingTable/buildLookupAltIndex's signature and future diagnostics
  return {
    row: (key) => rows.get(key),
    label: (key, locale, fallback) =>
      readRowField(rows.get(key), descriptor.present?.label, descriptor.present?.by, locale, fallback),
    compareKeys: (a, b, locale) => {
      const sortField = descriptor.sortBy ?? descriptor.present?.label
      const av = readRowField(rows.get(a), sortField, descriptor.present?.by, locale) ?? a
      const bv = readRowField(rows.get(b), sortField, descriptor.present?.by, locale) ?? b
      return av < bv ? -1 : av > bv ? 1 : 0
    },
  }
}

/**
 * The lookup-label HALF of `presentForJoin` (#626 retirement, spec §5;
 * matrix-tier coverage added #650 Task 7) — resolves `<field>Label` for
 * every declared lookup field with a `present` dressing dimension, sync,
 * from `getSnapshotRows` (the vault-built `LookupViaConfig.snapshotFor`
 * closure — now descriptor-routed, see `registry.ts`'s
 * `buildLookupSnapshotRows`; static tier reads its own in-config `table`
 * directly, no vault call — never `undefined` for a declared static table).
 * Mirrors `binding.ts`'s `runLookupPresent` (the async `present()` hook)
 * minus the array/`[].`-wildcard handling that hook needs for full-record
 * reads — join dressing only ever sees the joined RIGHT-side record's
 * scalar fields, so that complexity doesn't apply here.
 */
function presentLookupForJoin(
  record: Record<string, unknown>,
  locale: string,
  lookupFields: Record<string, LookupDescriptor>,
  getSnapshotRows: (descriptor: LookupDescriptor) => ReadonlyMap<string, Record<string, unknown>> | undefined,
): Record<string, unknown> {
  let result = record
  for (const [field, desc] of Object.entries(lookupFields)) {
    if (desc.present === undefined) continue
    const raw = record[field]
    if (typeof raw !== 'string') continue
    const rows = desc.backing === 'static'
      ? (desc.table ? new Map(Object.entries(desc.table)) : undefined)
      : getSnapshotRows(desc)
    if (!rows) continue
    const label = buildLookupSnapshot(desc.dimension, rows, desc).label(raw, locale)
    if (label === undefined) continue
    if (result === record) result = { ...record }
    result[`${field}Label`] = label
  }
  return result
}

/**
 * Build the combined sync `presentForJoin(record, locale)` hook a
 * `Collection` attaches to the `JoinableSource` it exposes
 * (`querySourceForJoin()`) — the i18n-text half (`presentI18nForJoin`, the
 * exact `applyI18nLocale(..., 'join')` partial application
 * `kernel/query/relate/join.ts` used to call directly, #626) composed with the
 * lookup-label half above. `undefined` when the collection declares
 * neither — `JoinableSource.presentForJoin` then stays unset, matching
 * today's `i18nFields`-absent behavior exactly (#626 parity lock).
 */
export function buildPresentForJoin(
  i18nFields: Record<string, I18nTextDescriptor> | undefined,
  lookupFields: Record<string, LookupDescriptor> | undefined,
  getSnapshotRows: ((descriptor: LookupDescriptor) => ReadonlyMap<string, Record<string, unknown>> | undefined) | undefined,
): ((record: unknown, locale: string) => unknown) | undefined {
  const hasI18n = i18nFields !== undefined && Object.keys(i18nFields).length > 0
  const hasLookup = lookupFields !== undefined && Object.keys(lookupFields).length > 0
  if (!hasI18n && !hasLookup) return undefined
  const resolveRows = getSnapshotRows ?? (() => undefined)
  return (record, locale) => {
    if (record === null || typeof record !== 'object') return record
    let result = record as Record<string, unknown>
    if (hasI18n) result = presentI18nForJoin(result, i18nFields, locale)
    if (hasLookup) result = presentLookupForJoin(result, locale, lookupFields, resolveRows)
    return result
  }
}
