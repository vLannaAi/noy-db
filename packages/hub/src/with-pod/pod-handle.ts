/**
 * Vault bundle handle — the stable opaque ULID identifying a vault
 * across `.noydb` exports.
 *
 * Behaviour is byte-identical to the inline `Vault.getPodHandle`
 * method this function replaced. `Vault` keeps the public method as
 * a thin delegator.
 *
 * Internal — reached through `vault.getPodHandle()`.
 */
import { NOYDB_FORMAT_VERSION } from '../kernel/types.js'
import type { NoydbStore, EncryptedEnvelope } from '../kernel/types.js'

/**
 * Return the stable opaque bundle handle for the given vault adapter,
 * generating and persisting a fresh ULID on first call.
 *
 * See {@link import('../kernel/vault.js').Vault.getPodHandle} for
 * the full rationale and storage-path documentation.
 */
export async function buildPodHandle(adapter: NoydbStore, name: string): Promise<string> {
  const existing = await adapter.get(name, '_meta', 'handle')
  if (existing) {
    try {
      const parsed = JSON.parse(existing._data) as unknown
      if (parsed !== null && typeof parsed === 'object' && 'handle' in parsed) {
        const handle = (parsed as { handle: unknown }).handle
        if (typeof handle === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(handle)) {
          return handle
        }
      }
    } catch {
      // Fall through to regenerate — corrupted handle envelope
      // is treated as missing, not as an error. The new handle
      // overwrites the bad one.
    }
  }
  const { generateULID } = await import('./ulid.js')
  const handle = generateULID()
  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify({ handle }),
  }
  await adapter.put(name, '_meta', 'handle', envelope)
  return handle
}
