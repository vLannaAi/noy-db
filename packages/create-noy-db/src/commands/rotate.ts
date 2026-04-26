/**
 * `noy-db rotate` — rotate the DEKs for one or more collections in
 * a vault.
 *
 * What it does
 * ------------
 * For each target collection:
 *
 *   1. Generate a fresh DEK
 *   2. Decrypt every record with the old DEK
 *   3. Re-encrypt every record with the new DEK
 *   4. Re-wrap the new DEK into every remaining user's keyring
 *
 * The old DEKs become unreachable as soon as the keyring files are
 * updated. This is the "just rotate" path — nobody is revoked,
 * everybody keeps their current permissions, but the key material
 * is replaced.
 *
 * Why expose this as a CLI command
 * --------------------------------
 * Two real-world scenarios:
 *
 *   1. **Suspected key leak.** An operator lost a laptop, a
 *      developer accidentally pasted a passphrase into a Slack
 *      channel, a USB stick went missing. Even if you think the
 *      passphrase is safe, rotating is cheap insurance.
 *
 *   2. **Scheduled rotation.** Some compliance regimes require
 *      periodic key rotation regardless of exposure. A CLI makes
 *      this scriptable from cron or a CI job.
 *
 * This module is test-first: all inputs are plain options, the
 * passphrase reader is injected, and the Noydb factory is
 * injectable. The production bin is a thin wrapper that defaults
 * those injections to their real implementations.
 */

import { createNoydb, type Noydb, type NoydbStore } from '@noy-db/hub'
import { jsonFile } from '@noy-db/to-file'
import type { ReadPassphrase } from './shared.js'
import { defaultReadPassphrase } from './shared.js'

export interface RotateOptions {
  /** Directory containing the vault data (file adapter only). */
  dir: string
  /** Vault (tenant) name to rotate keys in. */
  vault: string
  /** The user id of the operator running the rotate. */
  user: string
  /**
   * Explicit list of collections to rotate. When undefined, the
   * rotation targets every collection the user has a DEK for —
   * resolved at run time by reading the vault snapshot.
   */
  collections?: string[]
  /** Injected passphrase reader. Defaults to the clack implementation. */
  readPassphrase?: ReadPassphrase
  /**
   * Injected Noydb factory. Production code leaves this undefined
   * and gets `createNoydb`; tests pass a constructor that builds
   * against an in-memory adapter.
   */
  createDb?: typeof createNoydb
  /**
   * Injected adapter factory. Production code leaves this undefined
   * and gets `jsonFile`; tests pass one that returns the shared
   * in-memory adapter their fixture used.
   */
  buildAdapter?: (dir: string) => NoydbStore
}

export interface RotateResult {
  /** The collections that were actually rotated. */
  rotated: string[]
}

/**
 * Run the rotate flow against a file-adapter vault. Returns
 * the list of collections that were rotated so callers can display
 * it to the user.
 *
 * Throws `Error` on any auth/adapter/rotate failure. The bin
 * catches these and prints a friendly message; direct callers
 * (tests) can inspect the error message to assert specific
 * failure modes.
 */
export async function rotate(options: RotateOptions): Promise<RotateResult> {
  const readPassphrase = options.readPassphrase ?? defaultReadPassphrase
  const buildAdapter = options.buildAdapter ?? ((dir) => jsonFile({ dir }))
  const createDb = options.createDb ?? createNoydb

  // Read the passphrase BEFORE opening the database. This way a
  // cancelled prompt (Ctrl-C at the password entry) leaves the
  // adapter completely untouched — no files opened, no locks held.
  const secret = await readPassphrase(`Passphrase for ${options.user}`)

  let db: Noydb | null = null
  try {
    db = await createDb({
      store: buildAdapter(options.dir),
      user: options.user,
      secret,
    })

    // Resolve "all collections" by asking the vault. This
    // happens BEFORE rotate() is called, so the list is stable
    // across the operation — adding a new collection mid-rotate
    // would be a race we're not guarding against (single-writer
    // assumption applies).
    const vault = await db.openVault(options.vault)
    const targets = options.collections && options.collections.length > 0
      ? options.collections
      : await vault.collections()

    if (targets.length === 0) {
      throw new Error(
        `Vault "${options.vault}" has no collections to rotate.`,
      )
    }

    await db.rotate(options.vault, targets)
    return { rotated: targets }
  } finally {
    // Always close the DB on exit — success or failure. Close()
    // clears the KEK and DEKs from process memory, which is the
    // final line of defense if the passphrase somehow leaked
    // into a log line above this block.
    db?.close()
  }
}
