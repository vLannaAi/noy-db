/**
 * Cache policy helpers — parse human-friendly byte budgets into raw numbers.
 *
 * Accepted shapes (case-insensitive on suffix):
 *   number       — interpreted as raw bytes
 *   '1024'       — string of digits, raw bytes
 *   '50KB'       — kilobytes (×1024)
 *   '50MB'       — megabytes (×1024²)
 *   '1GB'        — gigabytes (×1024³)
 *
 * Decimals are accepted (`'1.5GB'` → 1610612736 bytes).
 *
 * Anything else throws — better to fail loud at construction time than
 * to silently treat a typo as 0 bytes (which would evict everything).
 */

const UNITS: Record<string, number> = {
  '': 1,
  'B': 1,
  'KB': 1024,
  'MB': 1024 * 1024,
  'GB': 1024 * 1024 * 1024,
  // 'TB' deliberately not supported — if you need it, you're not using NOYDB.
}

/** Parse a byte budget into a positive integer number of bytes. */
export function parseBytes(input: number | string): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) {
      throw new Error(`parseBytes: numeric input must be a positive finite number, got ${String(input)}`)
    }
    return Math.floor(input)
  }

  const trimmed = input.trim()
  if (trimmed === '') {
    throw new Error('parseBytes: empty string is not a valid byte budget')
  }

  // Accept either a bare number or a number followed by a unit suffix.
  // Regex: optional sign, digits with optional decimal, optional unit.
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]*)$/.exec(trimmed)
  if (!match) {
    throw new Error(`parseBytes: invalid byte budget "${input}". Expected format: "1024", "50KB", "50MB", "1GB"`)
  }

  const value = parseFloat(match[1]!)
  const unit = (match[2] ?? '').toUpperCase()

  if (!(unit in UNITS)) {
    throw new Error(`parseBytes: unknown unit "${match[2]}" in "${input}". Supported: B, KB, MB, GB`)
  }

  const bytes = Math.floor(value * UNITS[unit]!)
  if (bytes <= 0) {
    throw new Error(`parseBytes: byte budget must be > 0, got ${bytes} from "${input}"`)
  }
  return bytes
}

/**
 * Estimate the in-memory byte size of a decrypted record.
 *
 * Uses `JSON.stringify().length` as a stand-in for actual heap usage.
 * It's a deliberate approximation: real V8 heap size includes pointer
 * overhead, hidden classes, and string interning that we can't measure
 * from JavaScript. The JSON length is a stable, monotonic proxy that
 * costs O(record size) per insert — fine when records are typically
 * < 1 KB and the cache eviction is the slow path anyway.
 *
 * Returns `0` (and the caller must treat it as 1 for accounting) if
 * stringification throws on circular references; this is documented
 * but in practice records always come from JSON-decoded envelopes.
 */
export function estimateRecordBytes(record: unknown): number {
  try {
    return JSON.stringify(record).length
  } catch {
    return 0
  }
}
