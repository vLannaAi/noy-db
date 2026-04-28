/**
 * `@noy-db/hub/team` — subpath export for multi-user / sync / keyring.
 *
 * Solo-user apps that never call `grant()`, `db.push()`, or open a
 * sync target can exclude this subpath entirely — bundle savings
 * estimated at ~4-6 KB.
 *
 * The main `@noy-db/hub` entry still re-exports every symbol for
 * backward compatibility through.x.
 *
 * Named re-exports (not `export *`) so tsup keeps the barrel
 * populated even with `sideEffects: false`.
 */

// ─── Keyring / multi-user ───────────────────────────────────
export type { UnlockedKeyring } from './keyring.js'

// ─── Export-capability helpers (RFC #249) ───────────────────────────
export {
  hasExportCapability,
  evaluateExportCapability,
} from './keyring.js'

// ─── Import-capability helpers (issue #308) ─────────────────────────
export {
  hasImportCapability,
  evaluateImportCapability,
} from './keyring.js'

// ─── Sync engine ────────────────────────────────────────────
export { SyncEngine } from './sync.js'

// ─── Sync transactions ──────────────────────────────────
export { SyncTransaction } from './sync-transaction.js'

// ─── Presence / live cursors ────────────────────────────
export { PresenceHandle } from './presence.js'

// ─── _sync_credentials reserved collection ──────────────
export {
  putCredential,
  getCredential,
  deleteCredential,
  listCredentials,
  credentialStatus,
  SYNC_CREDENTIALS_COLLECTION,
} from './sync-credentials.js'
export type { SyncCredential } from './sync-credentials.js'
