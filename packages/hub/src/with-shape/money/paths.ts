/**
 * Nested-path support for `moneyFields` declarations (#334).
 *
 * A descriptor map key is a PATH, not just a top-level field name:
 *
 * - `'total'`                      — top-level scalar (the original form)
 * - `'billing.monthlyServiceFee'`  — nested object member
 * - `'lineItems[].amount'`         — member of every element of an array
 * - `'summary.*'`                  — every value of a record/map object
 * - `'income[].taxWithheld'`, `'byMonth.*.amount'` — segments compose
 *
 * Paths are parsed ONCE, at collection registration, and a syntactically
 * invalid declaration throws there — loudly, at setup time. (The
 * historical failure mode this kills: a declared-but-unreachable path
 * that was silently ignored, leaving the field un-quantized — a latent
 * 100× bug.) A path that doesn't match a given record at write time is
 * NOT an error — optional fields and empty arrays are legitimate — but
 * a path segment that hits a value of the WRONG SHAPE (`[]` on a
 * non-array, `.*` on a non-object) throws, because that means the
 * declaration and the data model disagree.
 */

import { ValidationError } from '../errors.js'

export type MoneyPathSegment =
  | { readonly kind: 'key'; readonly key: string; readonly array: boolean }
  | { readonly kind: 'wildcard'; readonly array: boolean }

const SEGMENT_RE = /^(\*|[^.[\]*]+)(\[\])?$/

const parseCache = new Map<string, readonly MoneyPathSegment[]>()

/**
 * Parse a moneyFields path into segments. Throws `ValidationError` on
 * bad syntax. Results are memoized — the same declared paths are walked
 * on every write/read.
 */
export function parseMoneyPath(path: string): readonly MoneyPathSegment[] {
  const cached = parseCache.get(path)
  if (cached) return cached

  if (typeof path !== 'string' || path.length === 0) {
    throw new ValidationError('moneyFields: path must be a non-empty string')
  }
  const segments: MoneyPathSegment[] = []
  for (const part of path.split('.')) {
    const m = SEGMENT_RE.exec(part)
    if (!m) {
      throw new ValidationError(
        `moneyFields: invalid path "${path}" — segment "${part}" must be a key, "key[]", "*", or "*[]"`,
      )
    }
    const array = m[2] === '[]'
    segments.push(
      m[1] === '*' ? { kind: 'wildcard', array } : { kind: 'key', key: m[1]!, array },
    )
  }
  parseCache.set(path, segments)
  return segments
}

/** True when the path is a plain top-level field name (the fast path). */
export function isSimpleMoneyPath(path: string): boolean {
  return !path.includes('.') && !path.includes('[') && !path.includes('*')
}

/**
 * Validate every declared path's syntax. Call at collection
 * registration so typos throw at setup, not silently no-op per write.
 */
export function validateMoneyFieldPaths(moneyFields: Record<string, unknown>): void {
  for (const path of Object.keys(moneyFields)) parseMoneyPath(path)
}

/**
 * The leaf visitor: receives the (already-cloned) container holding the
 * money value and the key/index of that value. Mutating the container
 * is safe — every container on a matched path is a fresh clone.
 */
export type MoneyLeafVisitor = (
  container: Record<string, unknown> | unknown[],
  key: string | number,
) => void

/**
 * Walk `node` along `segments`, copy-on-write-cloning every container on
 * a matched path, and call `visit` at each leaf position. Returns the
 * (possibly new) node; unmatched paths return the input untouched.
 *
 * Shape mismatches (`[]` on a non-array, `*` on a non-object) THROW on
 * the write path — the declaration and the data model disagree, and
 * writing through would store an un-quantized amount. On the READ path
 * pass `lenient: true` instead: stored data predating a declaration
 * change must stay readable, so a mismatched node is returned untouched
 * (mirrors the defensive `continue` the flat decoder always had).
 */
export function transformAtMoneyPath(
  node: unknown,
  path: string,
  segments: readonly MoneyPathSegment[],
  index: number,
  visit: MoneyLeafVisitor,
  lenient: boolean,
): unknown {
  if (node === null || node === undefined) return node
  const seg = segments[index]!
  const last = index === segments.length - 1

  if (seg.kind === 'key') {
    if (typeof node !== 'object' || Array.isArray(node)) {
      if (lenient) return node
      throw new ValidationError(
        `moneyFields: path "${path}" expected an object at segment "${seg.key}", got ${Array.isArray(node) ? 'an array' : typeof node}`,
      )
    }
    const obj = node as Record<string, unknown>
    if (!(seg.key in obj) || obj[seg.key] === null || obj[seg.key] === undefined) return node

    if (seg.array) {
      const arr = obj[seg.key]
      if (!Array.isArray(arr)) {
        if (lenient) return node
        throw new ValidationError(
          `moneyFields: path "${path}" declares "${seg.key}[]" but the value is not an array`,
        )
      }
      const cloned = [...arr]
      if (last) {
        for (let i = 0; i < cloned.length; i++) visit(cloned, i)
      } else {
        for (let i = 0; i < cloned.length; i++) {
          cloned[i] = transformAtMoneyPath(cloned[i], path, segments, index + 1, visit, lenient)
        }
      }
      return { ...obj, [seg.key]: cloned }
    }

    const clone = { ...obj }
    if (last) {
      visit(clone, seg.key)
    } else {
      clone[seg.key] = transformAtMoneyPath(clone[seg.key], path, segments, index + 1, visit, lenient)
    }
    return clone
  }

  // wildcard
  if (seg.array) {
    if (!Array.isArray(node)) {
      if (lenient) return node
      throw new ValidationError(`moneyFields: path "${path}" declares "*[]" but the value is not an array`)
    }
    const cloned = [...node]
    if (last) {
      for (let i = 0; i < cloned.length; i++) visit(cloned, i)
    } else {
      for (let i = 0; i < cloned.length; i++) {
        cloned[i] = transformAtMoneyPath(cloned[i], path, segments, index + 1, visit, lenient)
      }
    }
    return cloned
  }
  if (typeof node !== 'object' || Array.isArray(node)) {
    if (lenient) return node
    throw new ValidationError(
      `moneyFields: path "${path}" applies "*" to a non-object (${Array.isArray(node) ? 'array — use "*[]"' : typeof node})`,
    )
  }
  const obj = node as Record<string, unknown>
  const clone: Record<string, unknown> = { ...obj }
  for (const key of Object.keys(obj)) {
    const v = clone[key]
    if (v === null || v === undefined) continue
    if (last) visit(clone, key)
    else clone[key] = transformAtMoneyPath(v, path, segments, index + 1, visit, lenient)
  }
  return clone
}
