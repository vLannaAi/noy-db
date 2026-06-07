/**
 * Type-guard helper for narrowing discriminated-union records.
 *
 * `Collection<T>` correctly threads `T` through `get` / `query` / `scan`, but
 * accessing member-specific fields after reading from a `Collection<Union>`
 * still requires a narrowing step in application code. In regular `.ts` files
 * a simple `if (r.kind === 'IV')` block narrows correctly; in vue-tsc /
 * template contexts the inline comparison is sometimes not enough, and the
 * helper below makes the guard portable and avoids `as unknown as …` casts.
 *
 * **Usage with Collection<T>**
 *
 * ```ts
 * import { isDiscriminant } from '@noy-db/hub'
 *
 * type IV = { kind: 'IV'; invoiceNo: string; amount: number }
 * type RE = { kind: 'RE'; receiptNo: string; paidAt: string }
 * type Receipt = IV | RE | ...
 *
 * const receipts = await vault.collection<Receipt>('receipts').query().toArray()
 *
 * // Filter approach — result is IV[], invoiceNo accessible without cast:
 * const ivs = receipts.filter(r => isDiscriminant(r, 'kind', 'IV'))
 * console.log(ivs[0].invoiceNo)
 *
 * // Branch approach:
 * for (const r of receipts) {
 *   if (isDiscriminant(r, 'kind', 'IV')) {
 *     console.log(r.invoiceNo)  // r: IV here
 *   }
 * }
 * ```
 *
 * @module
 */

/**
 * Type-guard for narrowing a discriminated-union record by its discriminant.
 *
 * Returns `true` when `record[key] === value`, and narrows `record` to
 * `Extract<T, Record<K, V>>` — the exact union member(s) that carry that
 * discriminant value.
 *
 * The discriminant key is a parameter (not hardcoded to `'kind'`), so this
 * works with any field name: `'kind'`, `'type'`, `'tag'`, etc.
 *
 * @example
 *   const ivs = receipts.filter(r => isDiscriminant(r, 'kind', 'IV'))
 *   // ivs: IV[]  — invoiceNo accessible, no cast needed
 *
 * @typeParam T - The union type of the record (e.g. `Receipt`). Both type-alias
 *   unions and interface-extended unions work; use a `type` alias (`type Receipt = IV | RE`) for best
 *   results.
 * @typeParam K - The discriminant key (must be a key of `T`).
 * @typeParam V - The discriminant value to match. The `const` modifier ensures
 *   TypeScript infers the string literal (e.g. `'IV'`), not the full union
 *   `T[K]`, so the predicate resolves to the exact member type.
 */
export function isDiscriminant<
  T,
  K extends keyof T,
  const V extends T[K],
>(record: T, key: K, value: V): record is Extract<T, Record<K, V>> {
  return (record as Record<PropertyKey, unknown>)[key as PropertyKey] === value
}
