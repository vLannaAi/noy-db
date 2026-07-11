/**
 * _dict_* reserved collections + dictKey schema descriptor —
 *
 * Stores bounded enum-like field dictionaries as reserved encrypted
 * collections (`_dict_<name>/`) within a vault. Each dictionary
 * entry maps a stable key (e.g. `'paid'`) to a locale → label record
 * (e.g. `{ en: 'Paid', th: 'ชำระแล้ว' }`).
 *
 * Design decisions
 * ────────────────
 *
 * **Why reserved collections, not a separate store?**
 * Same answer as `_sync_credentials`: the compartment's existing
 * encryption stack is exactly right. Dictionaries are encrypted under the
 * same vault DEK, inherit ACL, ledger, and backup/restore for free.
 *
 * **One collection per dictionary, not one collection with namespaces.**
 * Each `_dict_<name>/` collection holds entries `{ id: key, labels: {...} }`.
 * This composes with `ref()` naturally (a dictKey IS a ref to the dict
 * collection), and means the query DSL works over dictionary entries
 * without any special-casing.
 *
 * **dictKey() is a descriptor, not a Zod type.**
 * The descriptor pattern matches `ref()`: declare NOYDB-specific metadata
 * in the collection options alongside `refs`. TypeScript inference comes
 * from the descriptor's generic parameter, not from Zod internals.
 *
 * API:
 *   `dictKey(name, keys?)` — returns a DictKeyDescriptor
 *   `vault.dictionary(name)` — returns a DictionaryHandle
 *   `DictionaryHandle.put/putAll/get/delete/rename/list` — CRUD
 *
 * The storage engine (`DictionaryHandle`, `DictEntry`, `DictionaryOptions`,
 * `DICT_COLLECTION_PREFIX`, `dictCollectionName`) moved to
 * `shape/via-lookup/handle.ts` (#650 Task 1 — via-lookup extraction, phase
 * D of the Via port) and is renamed `LookupHandle` there; re-exported here
 * under the original names for one release so existing importers of this
 * module compile unchanged. This file keeps only the descriptor factories
 * (`dictKey`/`staticDict`), which are locale/i18n-coupled and stay put.
 */

import type { OnMissingPolicy } from './policy.js'
import { linkI18nVia } from './binding.js'

// `isDictCollectionName` now lives on the kernel port (#623 Task 7,
// port/with/i18n-strategy.ts) — re-exported here for compat. Its `'_dict_'`
// check is a duplicate of DICT_COLLECTION_PREFIX (now on
// shape/via-lookup/handle.ts, not an import, to avoid a port→feature value
// dependency); keep the two in sync.
export { isDictCollectionName } from '../../port/with/i18n-strategy.js'

// Storage-engine re-exports (#650 Task 1 — moved to shape/via-lookup/handle.ts).
export {
  DictionaryHandle,
  DICT_COLLECTION_PREFIX,
  dictCollectionName,
  type DictEntry,
  type DictionaryOptions,
} from '../via-lookup/handle.js'

// ─── DictKey descriptor ────────────────────────────────────────────────

/**
 * Descriptor returned by `dictKey()`. Attach to the collection's
 * `dictKeyFields` option to declare which fields are dictionary-backed:
 *
 * ```ts
 * const invoices = company.collection<Invoice>('invoices', {
 *   dictKeyFields: {
 *     status: dictKey('status', ['draft', 'open', 'paid'] as const),
 *   },
 * })
 * ```
 *
 * The generic parameter `Keys` narrows the TypeScript type of the field
 * to a literal union; the runtime value of `keys` is used by `put()`
 * validation to reject unknown keys when a key set is declared.
 */
export interface DictKeyDescriptor<Keys extends string = string> {
  readonly _noydbDictKey: true
  /** Via port brand marker (#623 Task 9) — dictKey shares the i18n binding brand. */
  readonly _viaBrand: 'i18n'
  /** Which dictionary this field references. */
  readonly name: string
  /** Declared valid keys. When set, `put()` rejects keys not in this set. */
  readonly keys: readonly Keys[] | undefined
  /**
   * What to do when a label is missing for the resolved locale. Mirrors
   * `i18nText`'s `onMissing`. Default behavior (when unset) preserves the
   * legacy contract: a missing label is omitted (scalar) or `null`
   * (array element) — i.e. `'null'`. Set `'substitute'` to walk the
   * declared `substitute` chain, or `'throw'` to raise.
   */
  readonly onMissing?: OnMissingPolicy
  /** Ordered preferred-substitute locales for label resolution. */
  readonly substitute?: readonly string[]
  /**
   * Optional inline display labels (value → label map). A SYNC display
   * fallback for `describe()` when async `dictLabels` (from `_dict_`) are
   * not resolved. The async path still wins when available.
   */
  readonly labels?: Record<string, string>
}

/**
 * Create a `DictKeyDescriptor` for a dictionary-backed enum field.
 *
 * @param name        The dictionary name (corresponds to `_dict_<name>` collection).
 * @param keysOrMap   Either:
 *   - An `as const` array of valid key literals — narrows the TypeScript type
 *     to a literal union and enables put-time validation.
 *   - A **value→label map** (`{ draft: 'Draft', paid: 'Paid' }`) — keys are
 *     inferred from the map, and the labels are stored as inline display
 *     defaults surfaced by `describe()` without a store read.
 * @param opts        `{ labels?, onMissing?, substitute? }` when the array form
 *                    is used; `opts.labels` provides inline display defaults for
 *                    specific keys (same semantics as the map form, but
 *                    explicit key order from the array is preserved).
 *
 * @example
 * ```ts
 * // array form (original):
 * dictKey('status', ['draft', 'open', 'paid'] as const)
 *
 * // value→label map form (keys inferred, inline labels for describe()):
 * dictKey('status', { draft: 'Draft', open: 'Open', paid: 'Paid' })
 *
 * // array + opts.labels (preserves explicit order, partial labels OK):
 * dictKey('status', ['draft', 'open', 'paid'] as const, { labels: { paid: 'Paid' } })
 * ```
 */
export function dictKey<Keys extends string>(
  name: string,
  keysOrMap?: readonly Keys[] | Record<Keys, string>,
  opts?: { onMissing?: OnMissingPolicy; substitute?: readonly string[]; labels?: Record<string, string> },
): DictKeyDescriptor<Keys> {
  // The declaration is the Via binding's opt-in unit (#553) — same pattern
  // as i18nText()/money().
  linkI18nVia()
  let keys: readonly Keys[] | undefined
  let labels: Record<string, string> | undefined
  if (Array.isArray(keysOrMap)) {
    keys = keysOrMap as readonly Keys[]
    labels = opts?.labels
  } else if (keysOrMap && typeof keysOrMap === 'object') {
    keys = Object.keys(keysOrMap) as Keys[]
    labels = keysOrMap as Record<string, string>
  } else {
    keys = undefined
    labels = opts?.labels
  }
  return {
    _noydbDictKey: true,
    _viaBrand: 'i18n',
    name,
    keys,
    ...(opts?.onMissing !== undefined ? { onMissing: opts.onMissing } : {}),
    ...(opts?.substitute !== undefined ? { substitute: opts.substitute } : {}),
    ...(labels !== undefined ? { labels } : {}),
  }
}

// `isDictKeyDescriptor` now lives on the kernel port (#623 Task 11,
// port/with/i18n-strategy.ts, alongside `isStaticDictDescriptor`) —
// re-exported here for compat with existing importers of this module.
export { isDictKeyDescriptor } from '../../port/with/i18n-strategy.js'

// ─── StaticDict descriptor (code-provided dictionary) ──────────────────

/**
 * Descriptor returned by `staticDict()`. A sibling to {@link DictKeyDescriptor}
 * for **closed, defined-in-code, identical-across-vaults** enums (honorific,
 * civil-status, gender, religion, ContactTitle, status…).
 *
 * Unlike `dictKey`, the labels are supplied **at registration in code** and
 * resolved through the *same* label machinery, but with **no `_dict_*`
 * per-vault encrypted copy** and **no `rename()`**. The record stores only
 * the **code**; a static dict has no mutation surface.
 *
 * **Hybrid resolution.** Because a static dict is pure code with no
 * vault-locale dependency, it can — via a configured `displayLocale` — emit a
 * `<field>Label` even under a **locale-less read** (the property a locale-less
 * consumer needs and `dictKey` cannot provide). When a locale *is* active it
 * behaves exactly like `dictKey` (honoring `onMissing`/`substitute`).
 *
 * ```ts
 * const workers = vault.collection<Worker>('workers', {
 *   dictKeyFields: {
 *     civilStatus: staticDict('civilStatus', {
 *       adultMale:   { th: 'นาย',    en: 'Mr'  },
 *       adultFemale: { th: 'นาง',    en: 'Mrs' },
 *     }, { displayLocale: 'th' }),
 *   },
 * })
 * ```
 */
export interface StaticDictDescriptor<Keys extends string = string> {
  readonly _noydbStaticDict: true
  /** Via port brand marker (#623 Task 9) — staticDict shares the i18n binding brand. */
  readonly _viaBrand: 'i18n'
  /** Which dictionary this field references (the registry name). */
  readonly name: string
  /** The in-code label table: key → { locale → label }. */
  readonly table: Readonly<Record<Keys, Readonly<Record<string, string>>>>
  /** Declared valid keys — derived from `Object.keys(table)`. */
  readonly keys: readonly Keys[]
  /**
   * Locale used to emit `<field>Label` under a **locale-less** read — the
   * hybrid hinge. When unset, a static dict behaves like `dictKey` under a
   * locale-less read (no label); a locale-less consumer almost always wants
   * it set.
   */
  readonly displayLocale?: string
  /** Same `onMissing` policy engine as `dictKey`. Default `'null'`. */
  readonly onMissing?: OnMissingPolicy
  /** Ordered preferred-substitute locales for label resolution. */
  readonly substitute?: readonly string[]
  /**
   * Validate the stored code against `keys` on every `put()`. Default `true`
   * — codes are closed by construction, so an unknown code is a bug. Set
   * `false` to allow open codes (skips the `UnknownDictCodeError` guard).
   */
  readonly validateCodes?: boolean
}

/**
 * Create a `StaticDictDescriptor` for a code-provided enum field — a sibling
 * to {@link dictKey} for closed, code-defined, identical-across-vaults enums.
 *
 * The labels live in `table` (no `_dict_*` collection, no `rename()`); the
 * record stores only the stable code. Pass `displayLocale` so `<field>Label`
 * resolves even under a locale-less read.
 *
 * @param name   The dictionary name (used for the readonly-guard registry and
 *               the query label seam — never creates a `_dict_<name>` key).
 * @param table  `{ key: { locale: label } }` map.
 * @param opts   `displayLocale` (locale-less label), `onMissing`, `substitute`.
 *
 * @example
 * ```ts
 * staticDict('civilStatus', {
 *   adultMale:   { th: 'นาย',    en: 'Mr'  },
 *   adultFemale: { th: 'นาง',    en: 'Mrs' },
 * }, { displayLocale: 'th' })
 * ```
 */
export function staticDict<const T extends Record<string, Record<string, string>>>(
  name: string,
  table: T,
  opts?: {
    displayLocale?: string
    onMissing?: OnMissingPolicy
    substitute?: readonly string[]
    validateCodes?: boolean
  },
): StaticDictDescriptor<Extract<keyof T, string>> {
  // The declaration is the Via binding's opt-in unit (#553) — same pattern
  // as i18nText()/dictKey()/money().
  linkI18nVia()
  return {
    _noydbStaticDict: true,
    _viaBrand: 'i18n',
    name,
    table: table as Readonly<Record<Extract<keyof T, string>, Readonly<Record<string, string>>>>,
    keys: Object.keys(table) as Extract<keyof T, string>[],
    ...(opts?.displayLocale !== undefined ? { displayLocale: opts.displayLocale } : {}),
    ...(opts?.onMissing !== undefined ? { onMissing: opts.onMissing } : {}),
    ...(opts?.substitute !== undefined ? { substitute: opts.substitute } : {}),
    ...(opts?.validateCodes !== undefined ? { validateCodes: opts.validateCodes } : {}),
  }
}

// `isStaticDictDescriptor` now lives on the kernel port (#623 Task 7,
// port/with/i18n-strategy.ts) — re-exported here for compat.
export { isStaticDictDescriptor } from '../../port/with/i18n-strategy.js'

