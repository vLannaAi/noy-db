/**
 * `noy-db add user <id> <role>` — grant a new user access to a
 * vault.
 *
 * What it does
 * ------------
 * Wraps `noydb.grant()` in the CLI's auth-prompt ritual:
 *
 *   1. Prompt the caller for their own passphrase (to unlock the
 *      caller's keyring and derive the wrapping key).
 *   2. Prompt for the new user's passphrase.
 *   3. Prompt for confirmation of the new passphrase.
 *   4. Reject on mismatch.
 *   5. Call `noydb.grant(vault, { userId, role, passphrase, permissions })`.
 *
 * For owner/admin/viewer roles, every collection is granted
 * automatically (the core keyring.ts grant logic handles that via
 * the `permissions` field). For operator/client, the caller must
 * pass a `--collections` list because those roles need explicit
 * per-collection permissions.
 *
 * ## What this does NOT do
 *
 * - No email/invite flow — v0.5 is about local-CLI key management,
 *   not out-of-band user enrollment.
 * - No rollback on partial failure — `grant()` is atomic at the
 *   core level (keyring file writes last, after DEK wrapping), so
 *   partial-state-on-crash is already handled.
 */

import { createNoydb, type Noydb, type NoydbStore, type Role } from '@noy-db/hub'
import { jsonFile } from '@noy-db/to-file'
import type { ReadPassphrase } from './shared.js'
import { defaultReadPassphrase } from './shared.js'

export interface AddUserOptions {
  /** Directory containing the vault data (file adapter only). */
  dir: string
  /** Vault (tenant) name to grant access to. */
  vault: string
  /** The user id of the caller running the grant. */
  callerUser: string
  /** The new user's id (must not already exist in the vault keyring). */
  newUserId: string
  /** The new user's display name — shown in UI and audit logs. Defaults to `newUserId`. */
  newUserDisplayName?: string
  /** The new user's role. */
  role: Role
  /**
   * Per-collection permissions. Required when `role` is operator or
   * client; ignored for owner/admin/viewer (they get everything
   * via the core's resolvePermissions logic).
   *
   * Shape: `{ invoices: 'rw', clients: 'ro' }`. CLI callers pass
   * `--collections invoices:rw,clients:ro` and the argv parser
   * converts it to this shape.
   */
  permissions?: Record<string, 'rw' | 'ro'>
  /** Injected passphrase reader. Defaults to the clack implementation. */
  readPassphrase?: ReadPassphrase
  /** Injected Noydb factory. */
  createDb?: typeof createNoydb
  /** Injected adapter factory. */
  buildAdapter?: (dir: string) => NoydbStore
}

export interface AddUserResult {
  /** The userId that was granted access. */
  userId: string
  /** The role they were granted. */
  role: Role
}

/**
 * Run the grant flow. Two passphrase prompts: caller's, then new
 * user's (twice for confirmation). Calls `noydb.grant()` with the
 * collected values.
 */
export async function addUser(options: AddUserOptions): Promise<AddUserResult> {
  const readPassphrase = options.readPassphrase ?? defaultReadPassphrase
  const buildAdapter = options.buildAdapter ?? ((dir) => jsonFile({ dir }))
  const createDb = options.createDb ?? createNoydb

  // Operator/client roles NEED explicit permissions. Reject here
  // rather than in the middle of the grant, so the caller sees the
  // problem before any I/O happens.
  if (
    (options.role === 'operator' || options.role === 'client') &&
    (!options.permissions || Object.keys(options.permissions).length === 0)
  ) {
    throw new Error(
      `Role "${options.role}" requires explicit --collections — e.g. --collections invoices:rw,clients:ro`,
    )
  }

  const callerSecret = await readPassphrase(
    `Your passphrase (${options.callerUser})`,
  )
  const newSecret = await readPassphrase(
    `New passphrase for ${options.newUserId}`,
  )
  const confirmSecret = await readPassphrase(
    `Confirm passphrase for ${options.newUserId}`,
  )

  if (newSecret !== confirmSecret) {
    throw new Error(`Passphrases do not match — grant aborted.`)
  }

  let db: Noydb | null = null
  try {
    db = await createDb({
      store: buildAdapter(options.dir),
      user: options.callerUser,
      secret: callerSecret,
    })

    // Build the grant options. Only include `permissions` when the
    // caller actually supplied them — otherwise the core's
    // resolvePermissions fills in the role defaults. The spread
    // (rather than post-assignment) keeps the object literal
    // compatible with `GrantOptions`'s readonly `permissions`.
    const grantOpts: Parameters<Noydb['grant']>[1] = {
      userId: options.newUserId,
      displayName: options.newUserDisplayName ?? options.newUserId,
      role: options.role,
      passphrase: newSecret,
      ...(options.permissions ? { permissions: options.permissions } : {}),
    }

    await db.grant(options.vault, grantOpts)

    return {
      userId: options.newUserId,
      role: options.role,
    }
  } finally {
    db?.close()
  }
}
