/**
 * ⚠️ #1458 — this file is SHARED, not Reduce's.
 *
 * It moved into `query/reduce/` with `distinct()` and moved straight back: the
 * eager index layer (`with-lookup/indexing/eager-indexes.ts`) canonicalises its
 * bucket keys through `stringifyBucketKey` / `isProbeableBucketKey`, so
 * `@noy-db/hub/query` reaches it at runtime through the index fast path and the
 * query-tiers closure check said so. Two callers with different lifetimes —
 * `distinctKeyOf` for Reduce, the bucket-key pair for Find's indexes — and the
 * canonicalisation must be ONE definition or a probe and a bucket disagree.
 */

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
  if (value === null || value === undefined) return NULLISH_BUCKET_KEY
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  return OBJECT_BUCKET_KEY
}

/** The key a nullish value maps to. Nullish values are never INSERTED, so this bucket is always empty. */
const NULLISH_BUCKET_KEY = '\0NULL\0'
/** The key EVERY non-Date object maps to — one shared bucket, not a per-object identity. */
const OBJECT_BUCKET_KEY = '\0OBJECT\0'

/**
 * Is this OPERAND one a hash bucket can answer for? (#1402)
 *
 * ⛔ Two of {@link stringifyBucketKey}'s outputs are not addresses, and a
 * probe that treats them as one returns wrong rows SILENTLY — the #1402
 * failure mode, and measured on `main` for ordinary non-Via fields:
 *
 *  - `'\0OBJECT\0'` is a COLLISION BUCKET, not a sentinel. Every non-Date
 *    object-valued record in the collection sits in it, so
 *    `where('obj', '==', { k: 1 })` matched `[a, b]` from the index against
 *    `[]` from the scan (the scan compares by reference and matches
 *    neither). The doc above says *"objects produce a sentinel that no real
 *    record will match"*; that was true of the OPERAND and false of the
 *    stored values, which is exactly the half that decides the answer.
 *  - `'\0NULL\0'` is an empty bucket, because nullish values are never
 *    inserted. Probing it returns `EMPTY_SET`, which reads as "no matches"
 *    rather than "I cannot answer" — so `where('tag', '==', undefined)`
 *    returned `[]` from the index against the records that genuinely have
 *    no `tag` from the scan. The doc above already claims this case *"falls
 *    back to a linear scan"*; it did not.
 *
 * Both are fixed at the PROBE, never at the bucketing: a caller that gets
 * `false` here must return `null` (= "no index answer, scan it"), not an
 * empty set. Bucketing is untouched, so no stored data or persisted sidecar
 * moves.
 *
 * ⚠️ EAGER MODE ONLY, deliberately. `PersistedCollectionIndex` (lazy) has
 * no scan to fall back TO — refusing there converts wrong rows into an
 * `IndexRequiredError`, which is a behaviour decision of its own and is
 * left open rather than smuggled in here.
 */
export function isProbeableBucketKey(value: unknown): boolean {
  const key = stringifyBucketKey(value)
  return key !== NULLISH_BUCKET_KEY && key !== OBJECT_BUCKET_KEY
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
