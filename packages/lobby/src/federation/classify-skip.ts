import { NoAccessError } from '@noy-db/hub/kernel'
import type { SkippedVault } from './types.js'

/**
 * Classify a per-shard fan-out failure. `NoAccessError` (no keyring envelope for
 * the calling identity) is the unambiguous not-granted signal → `'no-grant'`
 * (expected under scoped access, not a fault). Everything else → `'error'` —
 * `InvalidKeyError`/`DecryptionError`/`KeyringCorruptError` can mean "wrong KEK
 * OR whole-file corruption" per loadKeyring, so they must not hide as no-grant.
 */
export function classifyShardSkip(err: Error): Exclude<SkippedVault['reason'], 'schema-drift'> {
  return err instanceof NoAccessError ? 'no-grant' : 'error'
}
