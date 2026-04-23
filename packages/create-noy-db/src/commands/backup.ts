/**
 * `noy-db backup <target>` — dump a vault to a local file.
 *
 * What it does
 * ------------
 * Wraps `vault.dump()` in the CLI's auth-prompt ritual, then
 * writes the serialized backup to the requested path. As of v0.4,
 * `dump()` already produces a verifiable backup (embedded
 * ledgerHead, full `_ledger` / `_ledger_deltas` snapshots) — the
 * CLI just moves bytes; the integrity guarantees come from core.
 *
 * ## Target URI support
 *
 * v0.5.0 ships **`file://` only** (or a plain filesystem path).
 * The issue spec originally called for `s3://` as well, but
 * wiring @aws-sdk into @noy-db/create would defeat the
 * zero-runtime-deps story for the CLI package. S3 backup is
 * deferred to a follow-up that can live in @noy-db/s3-cli or a
 * similar optional companion package.
 *
 * Accepted forms:
 *   - `file:///absolute/path.json`
 *   - `file://./relative/path.json`
 *   - `/absolute/path.json` (treated as `file://`)
 *   - `./relative/path.json` (treated as `file://`)
 *
 * ## What this does NOT do
 *
 * - No encryption of the backup BEYOND what noy-db already does.
 *   The dumped file is a valid noy-db backup, which means
 *   individual records are still encrypted but the keyring is
 *   included (wrapped with each user's KEK). Anyone who loads
 *   the backup still needs the correct passphrase to read.
 * - No restore — that's a separate subcommand tracked as a
 *   follow-up. For now users can restore via
 *   `vault.load(backupString)` from their own app code.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createNoydb, type Noydb, type NoydbStore } from '@noy-db/hub'
import { jsonFile } from '@noy-db/to-file'
import type { ReadPassphrase } from './shared.js'
import { defaultReadPassphrase } from './shared.js'

export interface BackupOptions {
  /** Directory containing the vault data (file adapter only). */
  dir: string
  /** Vault (tenant) name to back up. */
  vault: string
  /** The user id of the operator running the backup. */
  user: string
  /**
   * Where to write the backup. Accepts a `file://` URI or a plain
   * filesystem path. Relative paths resolve against `process.cwd()`.
   */
  target: string
  /** Injected passphrase reader. */
  readPassphrase?: ReadPassphrase
  /** Injected Noydb factory. */
  createDb?: typeof createNoydb
  /** Injected adapter factory. */
  buildAdapter?: (dir: string) => NoydbStore
}

export interface BackupResult {
  /** Absolute filesystem path the backup was written to. */
  path: string
  /** Size of the serialized backup in bytes. */
  bytes: number
}

/**
 * Parse a backup target into an absolute filesystem path. Rejects
 * unsupported URI schemes (s3://, https://, etc.) early so the
 * caller doesn't silently write to the wrong place.
 */
export function resolveBackupTarget(target: string, cwd: string = process.cwd()): string {
  // Strip the `file://` prefix if present. The rest of the string
  // is treated as a filesystem path. We accept both `file:///abs`
  // (three slashes, absolute) and `file://./rel` (two slashes,
  // relative) because real-world users write both.
  let raw = target
  if (target.startsWith('file://')) {
    raw = target.slice('file://'.length)
  } else if (target.includes('://')) {
    // Any other scheme is unsupported.
    throw new Error(
      `Unsupported backup target scheme: "${target.split('://')[0]}://". ` +
        `Only file:// and plain filesystem paths are supported in v0.5. ` +
        `S3 backups will land in a follow-up.`,
    )
  }
  return path.resolve(cwd, raw)
}

export async function backup(options: BackupOptions): Promise<BackupResult> {
  const readPassphrase = options.readPassphrase ?? defaultReadPassphrase
  const buildAdapter = options.buildAdapter ?? ((dir) => jsonFile({ dir }))
  const createDb = options.createDb ?? createNoydb

  // Resolve the target FIRST so a bad URI fails before any
  // passphrase is collected. This keeps the UX clean: a typo in
  // `s3://bucket/x` rejects without asking for a secret the user
  // would then have to type again.
  const absolutePath = resolveBackupTarget(options.target)

  const secret = await readPassphrase(`Passphrase for ${options.user}`)

  let db: Noydb | null = null
  try {
    db = await createDb({
      store: buildAdapter(options.dir),
      user: options.user,
      secret,
    })
    const vault = await db.openVault(options.vault)
    const serialized = await vault.dump()

    // Make sure the parent directory exists. If the user passed
    // `./backups/2026/demo.json` and `./backups/2026` doesn't
    // exist yet, we create it. This is the common case for
    // scripted rotations dropping into a date-based folder.
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, serialized, 'utf8')

    return {
      path: absolutePath,
      bytes: Buffer.byteLength(serialized, 'utf8'),
    }
  } finally {
    db?.close()
  }
}
