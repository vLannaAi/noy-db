/**
 * `lookup()` / `enumOf()` / `dict()` descriptors — the three declaration
 * surfaces for the `'lookup'` via binding (#650 Task 2, phase D of the Via
 * port). One `LookupDescriptor` shape; the tiers are `backing` details:
 *
 * - `lookup(dimension, opts?)`  — matrix tier: first-class collection backing
 *   (default `backing:'collection'`) — a reference-collection dimension
 *   (e.g. `countries`), open vocabulary by default.
 * - `enumOf(keys)`              — enum tier: static in-config table, CLOSED
 *   vocabulary, no backing store at all (no dimension name — pure inline
 *   keys). Exported as `enumOf`; the barrel (`index.ts`) re-exports it as
 *   `enum` (`enum` is a reserved word, so it can't be the function's own
 *   name).
 * - `dict(dimension, opts?)`    — dict tier: reserved `_dict_<dimension>`
 *   micro-collection backing (the `vault.dictionary(name)` engine), open
 *   vocabulary by default.
 *
 * Each factory calls {@link linkLookupVia} first — the declaration IS the
 * via binding's opt-in unit (#553), same pattern as `money()`/`i18nText()`/
 * `dictKey()`.
 */

import type { OnMissingPolicy } from '../via-i18n/policy.js'
import { linkLookupVia } from './binding.js'

/** `'closed'` = enum semantics (membership enforced, Task 3); `'open'` permits unknown keys. */
export type Vocabulary = 'open' | 'closed'

/** Where a dimension's rows live: static in-config table / reserved micro-collection / first-class collection. */
export type LookupBacking = 'static' | 'reserved' | 'collection'

/** Delete-time referential policy for the backing dimension (default `'restrict'`, enforced in Task 5). */
export type OnDelete = 'restrict' | 'cascade' | 'nullify'

/** The one descriptor shape every tier compiles to — tiers differ only by `backing`. */
export interface LookupDescriptor<Keys extends string = string> {
  readonly _viaBrand: 'lookup'
  /** Dimension/dictionary/target name. Empty for a bare `enumOf()` (no backing store, no name). */
  readonly dimension: string
  /** Canonical key field on the row (default `'id'`). */
  readonly key: string
  /** Candidate keys normalized to `key` on ingest (Task 3). */
  readonly altKeys?: readonly string[]
  readonly vocabulary: Vocabulary
  /** Dressing dimension: which backing-row field supplies `<field>Label`, optionally keyed `by` a sub-field (e.g. locale). */
  readonly present?: { readonly label: string; readonly by?: string }
  /** Field to sort by against the snapshot (Task 6). */
  readonly sortBy?: string
  readonly backing: LookupBacking
  readonly onDelete: OnDelete
  /** Static/enum inline key set. */
  readonly keys?: readonly Keys[]
  /** Static tier only: in-code `key -> { locale -> label }` table. */
  readonly table?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Static hybrid hinge (the `staticDict` alias) — locale-less `<field>Label`. */
  readonly displayLocale?: string
  readonly onMissing?: OnMissingPolicy
  readonly substitute?: readonly string[]
  /** Inline display labels (value -> label), the dict-tier sync fallback (mirrors `dictKey`'s `labels`). */
  readonly labels?: Record<string, string>
}

/**
 * Matrix tier — first-class collection backing (default `backing:'collection'`).
 * `dimension` names the backing collection (e.g. `'countries'`).
 *
 * `backing` may be overridden to construct any tier through this one
 * factory — e.g. `lookup(name, { backing:'static', table, displayLocale })`
 * is the table-bearing static tier `staticDict()` compiles onto. The
 * `table`/`displayLocale`/`keys`/`onMissing`/`substitute`/`labels` options
 * are a superset of the brief's literal opts list: `LookupDescriptor`
 * already carries these fields for exactly this purpose, and without them
 * `backing:'static'` would be unreachable stand-alone through `lookup()`
 * (see task-2-report.md's "Design decisions").
 *
 * **`altKeys` caveat (matrix tier only)**: normalizing an altKey candidate
 * to its canonical `key` requires the backing `dimension` collection to be
 * open in EAGER mode (the default; `{ prefetch: false }` — lazy mode — is
 * unsupported). A `put()` on a field with `altKeys` whose backing collection
 * is lazy throws a `ValidationError` naming the field and dimension; open
 * the backing collection without `{ prefetch: false }`, or drop `altKeys`.
 */
export function lookup<Keys extends string>(
  dimension: string,
  opts?: {
    key?: string
    altKeys?: readonly string[]
    vocabulary?: Vocabulary
    present?: { label: string; by?: string }
    sortBy?: string
    backing?: LookupBacking
    onDelete?: OnDelete
    keys?: readonly Keys[]
    table?: Readonly<Record<string, Readonly<Record<string, string>>>>
    displayLocale?: string
    onMissing?: OnMissingPolicy
    substitute?: readonly string[]
    labels?: Record<string, string>
  },
): LookupDescriptor<Keys> {
  linkLookupVia()
  return {
    _viaBrand: 'lookup',
    dimension,
    key: opts?.key ?? 'id',
    vocabulary: opts?.vocabulary ?? 'open',
    backing: opts?.backing ?? 'collection',
    onDelete: opts?.onDelete ?? 'restrict',
    ...(opts?.altKeys !== undefined ? { altKeys: opts.altKeys } : {}),
    ...(opts?.present !== undefined ? { present: opts.present } : {}),
    ...(opts?.sortBy !== undefined ? { sortBy: opts.sortBy } : {}),
    ...(opts?.keys !== undefined ? { keys: opts.keys } : {}),
    ...(opts?.table !== undefined ? { table: opts.table } : {}),
    ...(opts?.displayLocale !== undefined ? { displayLocale: opts.displayLocale } : {}),
    ...(opts?.onMissing !== undefined ? { onMissing: opts.onMissing } : {}),
    ...(opts?.substitute !== undefined ? { substitute: opts.substitute } : {}),
    ...(opts?.labels !== undefined ? { labels: opts.labels } : {}),
  }
}

/**
 * Enum tier — static in-config table, CLOSED vocabulary, no backing store.
 * No dimension name (pure inline keys) — `dimension` is `''`.
 */
export function enumOf<const Keys extends readonly string[]>(keys: Keys): LookupDescriptor<Keys[number]> {
  linkLookupVia()
  return {
    _viaBrand: 'lookup',
    dimension: '',
    key: 'id',
    vocabulary: 'closed',
    backing: 'static',
    onDelete: 'restrict',
    keys,
  }
}

/**
 * Dict tier — reserved `_dict_<dimension>` micro-collection backing (the
 * `vault.dictionary(dimension)` engine), open vocabulary by default. The
 * native equivalent of `dictKey()`.
 *
 * Unlike `lookup()`'s matrix tier, `dict()` has no `altKeys` option — its
 * `_dict_<dimension>` backing is the always-synchronous `LookupHandle`
 * write-through cache, never a `vault.collection()` that can be opened
 * `{ prefetch: false }`, so the matrix tier's lazy-mode altKeys restriction
 * does not apply here.
 */
export function dict<Keys extends string>(
  dimension: string,
  opts?: {
    keys?: readonly Keys[]
    vocabulary?: Vocabulary
    present?: { label: string; by?: string }
    onMissing?: OnMissingPolicy
    substitute?: readonly string[]
  },
): LookupDescriptor<Keys> {
  linkLookupVia()
  return {
    _viaBrand: 'lookup',
    dimension,
    key: 'id',
    vocabulary: opts?.vocabulary ?? 'open',
    backing: 'reserved',
    onDelete: 'restrict',
    ...(opts?.keys !== undefined ? { keys: opts.keys } : {}),
    ...(opts?.present !== undefined ? { present: opts.present } : {}),
    ...(opts?.onMissing !== undefined ? { onMissing: opts.onMissing } : {}),
    ...(opts?.substitute !== undefined ? { substitute: opts.substitute } : {}),
  }
}
