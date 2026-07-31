/**
 * Helpers for reading records out of a *plaintext* store (`encrypt: false`)
 * with native tooling — the programmatic core of a `noydb cat`-style unwrap.
 * See the plaintext/debug-store-mode design.
 */
import type { EncryptedEnvelope } from './types.js'

/**
 * The option's two failure modes, re-exported here so a consumer can `catch`
 * them by identity (#914). Both are thrown from the kernel — `createNoydb`
 * raises `DebugPlaintextError` when `debugPlaintext` is combined with
 * encryption, and the record codec raises `DebugReservedFieldError` for a
 * field colliding with the `_`-prefixed metadata. This entry is the only one
 * that publishes them.
 */
export { DebugPlaintextError, DebugReservedFieldError } from './errors.js'

/** Re-exported so `readPlaintextRecord`'s parameter is nameable from this entry. */
export type { EncryptedEnvelope } from './types.js'

/**
 * Extract the record from a plaintext stored envelope, handling both layouts:
 *
 *   - **classic plaintext** (`encrypt: false`): the record is JSON in `_data`.
 *   - **debugPlaintext**: the record's fields are inlined beside the
 *     `_`-prefixed metadata (marked by `_debug`).
 *
 * Returns `null` for an empty/absent body. Throws if handed an **encrypted**
 * envelope (non-empty `_iv`) — there is no key here; decrypt through the vault
 * instead. Intended for record envelopes, not blob chunks.
 *
 * @example
 * ```ts
 * // node script over a to-file store, no vault needed:
 * const env = JSON.parse(readFileSync('data/acme/invoices/inv-1.json', 'utf8'))
 * console.log(readPlaintextRecord(env)) // → { id: 'inv-1', total: '120.00', … }
 * ```
 */
export function readPlaintextRecord<T = Record<string, unknown>>(
  envelope: EncryptedEnvelope,
): T | null {
  if (envelope._iv !== '') {
    throw new Error(
      'readPlaintextRecord: envelope is encrypted (non-empty _iv) — decrypt via the vault, not this helper',
    )
  }
  if (envelope._debug !== undefined) {
    const record: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(envelope)) {
      if (!key.startsWith('_')) record[key] = value
    }
    return record as T
  }
  if (!envelope._data) return null
  return JSON.parse(envelope._data) as T
}
