import type { AttestationFieldSchema, Normalizer } from './types.js'

const NORMALIZERS: ReadonlySet<string> = new Set<Normalizer>([
  'trim', 'lower', 'upper', 'alnum-upper', 'digits', 'cents', 'iso-date',
])

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
    obj,
  )
}

/**
 * Normalize a field value to a canonical string for hashing.
 *
 * `iso-date` returns the **UTC** calendar date (`toISOString().slice(0,10)`),
 * so a local-time `Date` near midnight can shift by ±1 day in non-UTC
 * environments — prefer passing an ISO date string (e.g. `'2026-05-29'`)
 * over a local `new Date(2026, 4, 29)`. Issue and verify use this same
 * function, so a value passed identically on both sides always round-trips.
 */
export function normalizeField(value: unknown, n: Normalizer): string {
  switch (n) {
    case 'trim':
      return String(value).trim()
    case 'lower':
      return String(value).trim().toLowerCase()
    case 'upper':
      return String(value).trim().toUpperCase()
    case 'alnum-upper':
      return String(value).replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    case 'digits':
      return String(value).replace(/[^0-9]/g, '')
    case 'cents': {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new Error(`normalizeField(cents): not a finite number: ${String(value)}`)
        }
        return String(Math.round(value * 100))
      }
      // For string values: strip currency symbols / spaces / commas but keep digits, dot, minus
      const stripped = String(value).replace(/[^0-9.\-]/g, '')
      // A valid numeric string must have at least one digit
      if (!/[0-9]/.test(stripped)) {
        throw new Error(`normalizeField(cents): not a finite number: ${String(value)}`)
      }
      const num = Number(stripped)
      if (!Number.isFinite(num)) {
        throw new Error(`normalizeField(cents): not a finite number: ${String(value)}`)
      }
      return String(Math.round(num * 100))
    }
    case 'iso-date': {
      const d = value instanceof Date ? value : new Date(String(value))
      if (Number.isNaN(d.getTime())) {
        throw new Error(`normalizeField(iso-date): unparseable date: ${String(value)}`)
      }
      return d.toISOString().slice(0, 10)
    }
    default: {
      const exhaustive: never = n
      throw new Error(`normalizeField: unknown normalizer ${String(exhaustive)}`)
    }
  }
}

export function validateFieldSchema(schema: AttestationFieldSchema): void {
  if (!schema.fields || schema.fields.length === 0) {
    throw new Error('validateFieldSchema: schema must declare at least one field')
  }
  const seen = new Set<string>()
  for (const f of schema.fields) {
    if (!NORMALIZERS.has(f.normalize)) {
      throw new Error(
        `validateFieldSchema: unknown normalizer '${String(f.normalize)}' for path '${f.path}'`,
      )
    }
    if (seen.has(f.path)) {
      throw new Error(`validateFieldSchema: duplicate path '${f.path}'`)
    }
    seen.add(f.path)
  }
}
