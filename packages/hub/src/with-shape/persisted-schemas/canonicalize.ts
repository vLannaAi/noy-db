/**
 * Deterministic JSON serializer: sorts object keys lexicographically at every
 * depth so structurally-equivalent objects produce identical strings. Array
 * order is preserved (arrays are semantically ordered).
 *
 * Used by {@link sha256Hex} to fingerprint a derived JSON Schema for
 * hash-based skip on persisted-schema writes.
 *
 * @module
 */

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]))
  return '{' + parts.join(',') + '}'
}
