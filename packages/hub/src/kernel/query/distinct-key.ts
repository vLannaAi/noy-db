/**
 * The ONE definition of "are these two field values the same value?" (#1347).
 *
 * `distinct()`, `countDistinct()` and the eager hash index all have to answer
 * that question, and they have to answer it IDENTICALLY — an index-backed
 * `distinct()` reads bucket keys, a scanned one recomputes them, and the two
 * are only allowed to be different code paths because they are not different
 * definitions. So `stringifyBucketKey` lives here and `eager-indexes.ts`
 * imports it rather than keeping a private twin; a change to one is a change
 * to both by construction.
 *
 * ⚠️ THE KEY IS COMPUTED FROM THE **STORED** VALUE, never the decoded one.
 * That is what makes a Via-covered field behave: money stores a scaled
 * integer, and a legacy row written before the field was declared can hold a
 * non-canonical spelling of it (`'0100'` where a canonical write produces
 * `'100'`). Both denote 1.00, and `ViaPipeline.canonicalizeIndexKey` folds
 * them onto one key. Dedup on the raw string reports two values; dedup on the
 * FORMATTED string is worse still, because it makes distinctness depend on a
 * locale the query layer does not have.
 */

/**
 * Stringify a value into a stable bucket key.
 *
 * `null`/`undefined` produce a sentinel that records will never match (so we
 * never index nullish values — `where('x', '==', null)` falls back to a
 * linear scan). Numbers, booleans, strings, and Date objects are coerced via
 * `String()`. Objects produce a sentinel that no real record will match —
 * querying with object values is a code smell.
 */
export function stringifyBucketKey(value: unknown): string {
  if (value === null || value === undefined) return '\0NULL\0'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  return '\0OBJECT\0'
}

/**
 * The narrow slice of `ViaPipeline` a distinct key needs. Declared
 * structurally so this module — kernel spine — does not have to reach into a
 * `with-*` service, and so a caller holding only a money binder can satisfy it.
 */
export interface BucketKeyCanonicalizer {
  canonicalizeIndexKey(field: string, rawValue: unknown): string | undefined
}

/**
 * The distinct key for one stored field value, or `undefined` when the value
 * is NULLISH and therefore not a distinct value at all.
 *
 * ⭐ NULLISH IS EXCLUDED, DELIBERATELY. Three reasons, and the first is the
 * one that decides it: the hash index does not hold nullish values, so an
 * index-backed `distinct()` *cannot* report them, and a scan that did would
 * make the two paths disagree — a correctness bug that only appears on the
 * collections large enough to have an index. Second, it matches
 * `COUNT(DISTINCT x)` and Dexie's `uniqueKeys()`, so nobody is surprised.
 * Third, a caller who wants the nullish bucket can ask for it directly with
 * `.where(field, '==', null)`, which is cheap and says what it means.
 * (`groupBy()` goes the OTHER way and buckets nullish — that is not an
 * inconsistency: a group key is a partition of the rows, a distinct value is
 * a member of the field's value set.)
 */
export function distinctKeyOf(
  field: string,
  storedValue: unknown,
  via?: BucketKeyCanonicalizer,
): string | undefined {
  if (storedValue === null || storedValue === undefined) return undefined
  return via?.canonicalizeIndexKey(field, storedValue) ?? stringifyBucketKey(storedValue)
}
