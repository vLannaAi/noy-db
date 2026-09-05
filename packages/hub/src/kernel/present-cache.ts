/**
 * Per-record memo for the Via `present()` pass (#1419).
 *
 * `list()` and `get()` run the full presentation pipeline — money decode plus
 * its `<field>Formatted`/`<field>Number` siblings, i18n resolution, dictKey
 * labels, `computed({ mode: 'virtual' })` projection — on every call. Nothing
 * is decrypted the second time, so a warm `list()` of 10k rows was pure
 * re-decoration: measured 294 ms (28.5 us/row) against a 5.5 ms full predicate
 * scan of the same snapshot. `list()` is the read most consumers reach for (a
 * store mirror re-listing after each write, an export, a guard doing
 * list-and-filter), so each of them paid the whole collection per call.
 *
 * ## Why a WeakMap on the record, and not a generation stamp
 *
 * Presentation is a pure function of (record, locale, fallback, layer). Keying
 * on the RECORD OBJECT means an unrelated write does not throw away the other
 * 9,999 rows' decorations — which is exactly the reported workload, where a
 * mirror re-lists after every single put. A generation stamp (#1417's keyset
 * memo) is the right tool for a whole-collection derivative like a sort order;
 * it is the wrong one here, because it would invalidate everything on any
 * write and leave the reported case paying full price.
 *
 * Invalidation is then structural rather than maintained: `put` writes a FRESH
 * record object into the cache, so the previous object — and its entry here —
 * becomes unreachable and is collected. There is no stale window and nothing
 * to remember to clear.
 *
 * ⚠️ THE ASSUMPTION, STATED SO IT CAN BE CHECKED: a record object in the
 * collection cache is never mutated in place. This memo is exactly as sound as
 * that assumption — and no less sound than what already ships, because
 * `query().toArray()` hands out those same cache objects directly, so an
 * in-place mutation is already a defect that would corrupt query results
 * before it corrupted anything here. If in-place mutation is ever introduced,
 * it breaks the query path first and this second.
 *
 * ⭐ Entries hold a PROMISE, not a value, so two concurrent reads of the same
 * row at the same locale share one presentation pass instead of racing to do
 * it twice.
 *
 * @module
 */

/** Records are keyed by identity; the inner map is keyed by presentation variant. */
const memo = new WeakMap<object, Map<string, Promise<unknown>>>()

/**
 * A key that is equal only when the presentation provably is.
 *
 * `fallback` is a locale code or an ordered chain, so it is joined rather than
 * stringified — `['th','any']` and `'th,any'` are different requests and must
 * not share an entry. A space separates the parts, because no locale code,
 * layer name or fallback chain contains one.
 */
export function presentVariantKey(
  locale: string | undefined,
  layer: string,
  fallback: string | readonly string[] | undefined,
): string {
  const chain = fallback === undefined ? '' : Array.isArray(fallback) ? fallback.join(',') : String(fallback)
  return `${locale ?? ''} ${layer} ${chain}`
}

/**
 * Return the memoized presentation of `record` for `variant`, computing it
 * once via `compute`.
 *
 * A rejected `compute` is NOT retained: a transient failure must not become a
 * permanent one for the life of the record.
 */
export function memoizePresent<T>(
  record: object,
  variant: string,
  compute: () => Promise<T>,
): Promise<T> {
  let variants = memo.get(record)
  if (!variants) {
    variants = new Map()
    memo.set(record, variants)
  }
  const hit = variants.get(variant)
  if (hit !== undefined) return hit as Promise<T>

  const scope = variants
  const pending = compute().catch((err: unknown) => {
    scope.delete(variant)
    throw err
  })
  scope.set(variant, pending)
  return pending
}
