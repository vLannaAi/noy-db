/**
 * Generic dotted-path / `[]`-wildcard record helpers. Kernel-owned:
 * these carry zero i18n logic — they were extracted out of
 * `shape/via-i18n/core.ts` (Task 7, #623) so kernel call-sites (put-time
 * validation, densify) can import them without a spine→service edge.
 *
 * @internal
 */

/**
 * Return all leaf values at `path`, expanding `[].` array wildcards.
 *
 * - `'name'`              → `[obj.name]`
 * - `'address.lineOne'`   → `[obj.address.lineOne]`
 * - `'contacts[].title'`  → `[obj.contacts[0].title, obj.contacts[1].title, …]`
 *
 * Returns an empty array when the path does not resolve (missing key,
 * wrong type, etc.). Used by `enforceI18nOnPut` to validate nested fields.
 */
export function getAtPath(obj: Record<string, unknown>, path: string): unknown[] {
  const arrayIdx = path.indexOf('[].')
  if (arrayIdx !== -1) {
    const arrayKey = path.slice(0, arrayIdx)
    const restPath = path.slice(arrayIdx + 3)
    const arr = obj[arrayKey]
    if (!Array.isArray(arr)) return []
    return arr.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      return getAtPath(item as Record<string, unknown>, restPath)
    })
  }
  const dotIdx = path.indexOf('.')
  if (dotIdx !== -1) {
    const head = path.slice(0, dotIdx)
    const rest = path.slice(dotIdx + 1)
    const nested = obj[head]
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return []
    return getAtPath(nested as Record<string, unknown>, rest)
  }
  const val = obj[path]
  return val !== undefined ? [val] : []
}

/**
 * Mutate `obj` in-place, setting `value` at the nested `path`.
 * Supports dot notation (`'address.lineOne'`) but not array wildcards —
 * auto-translate on `contacts[].title` style paths is not supported.
 */
export function setAtPathInPlace(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const dotIdx = path.indexOf('.')
  if (dotIdx !== -1) {
    const head = path.slice(0, dotIdx)
    const rest = path.slice(dotIdx + 1)
    const nested = obj[head]
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return
    setAtPathInPlace(nested as Record<string, unknown>, rest, value)
    return
  }
  obj[path] = value
}
