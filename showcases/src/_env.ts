/**
 * Shared environment-gate helper for storage showcases.
 *
 * **Relationship to `_aws.ts`.** `_aws.ts` is the older AWS-specific
 * skip helper (single env var: `NOYDB_SHOWCASE_AWS_PROFILE`, used by
 * showcases 04 / 04b / 57). It still works and stays as-is — no point
 * thrashing existing callers. `_env.ts` is the generalised pattern for
 * every non-AWS credentialed store (postgres, mysql, supabase, R2, …):
 * pass a `vars[]` list, get a typed gate object back. Both produce the
 * same "Skipping — set $VAR in showcases/.env" hint shape.
 *
 * Cloud / network storage showcases need credentials that we never check
 * into the repo. The convention:
 *
 *   1. Each storage family gets a `NOYDB_SHOWCASE_<NAME>_*` env var family
 *      (documented in `showcases/.env.example`).
 *   2. Each showcase calls `envGate({ label, vars })` at module scope.
 *   3. The returned `enabled` flag drives `describe.skipIf(!gate.enabled)`,
 *      so the test runner reports a clear "skipped" line — never a fake green.
 *   4. When unset, `logSkipHint()` prints exactly which `.env` keys to fill in
 *      so the developer doesn't have to guess.
 *
 * The pattern intentionally mirrors `_aws.ts` (which predates this file and
 * stays as-is for the AWS-profile case) but is dependency-free and works for
 * any store that takes a connection string, an HTTP endpoint + token pair,
 * or any other arbitrary credential shape.
 */

export interface EnvGateOptions {
  /** Showcase label for log lines (e.g. `'to-postgres'`). */
  label: string
  /** Required env var names. The gate is `enabled` only when ALL are set. */
  vars: readonly string[]
}

export interface EnvGate {
  /** True iff every required var is set to a non-empty string. */
  readonly enabled: boolean
  /** Map of var name → value (undefined when missing). */
  readonly values: Record<string, string | undefined>
  /**
   * Throw if disabled. Use inside an `it.skipIf` body when you want a hard
   * "this should never run if the gate is open" assertion.
   */
  require(name: string): string
}

/**
 * Read env vars at module load and return a gate object the test file uses
 * for both `describe.skipIf` and value lookups inside the test.
 */
export function envGate(options: EnvGateOptions): EnvGate {
  const values: Record<string, string | undefined> = {}
  for (const name of options.vars) {
    const v = process.env[name]
    values[name] = v && v.length > 0 ? v : undefined
  }
  const enabled = options.vars.every((name) => values[name] !== undefined)
  return {
    enabled,
    values,
    require(name: string): string {
      const v = values[name]
      if (v === undefined) {
        throw new Error(
          `[${options.label}] env var ${name} is required but not set — gate should have skipped this showcase`,
        )
      }
      return v
    },
  }
}

/**
 * One-shot console hint that tells the developer how to enable a skipped
 * showcase. No-op when the gate is open.
 */
export function logSkipHint(label: string, gate: EnvGate, vars: readonly string[]): void {
  if (gate.enabled) return
  const missing = vars.filter((v) => gate.values[v] === undefined)
  // eslint-disable-next-line no-console
  console.info(
    `[${label}] Skipping — set ${missing.join(', ')} in showcases/.env to run this showcase against the real service.`,
  )
}

// ─── Per-store gates ────────────────────────────────────────────────────
//
// One named export per credentialed store — keeps the env var spelling in
// one place and lets the .env.example diff against this file by convention.

/** AWS profile (used by `to-aws-s3` and the real-service `to-aws-dynamo`). */
export const AWS_GATE_VARS = ['NOYDB_SHOWCASE_AWS_PROFILE'] as const

/**
 * Cloudflare R2 — S3-compatible API.
 *
 * `R2_BUCKET` is gate-required so the showcase fails fast on a missing
 * value rather than write to a name the developer didn't intend. The
 * showcase reads `R2_BUCKET ?? R2_DEFAULT_BUCKET`, so a developer can
 * leave the var unset to fall back to `noydb-showcase-r2`. The fallback
 * isn't baked into the gate vars list because the gate represents the
 * "do you have credentials at all?" question, which the bucket value
 * never answers — only the three credential vars do.
 */
export const R2_DEFAULT_BUCKET = 'noydb-showcase-r2'
export const R2_GATE_VARS = [
  'NOYDB_SHOWCASE_R2_ACCOUNT_ID',
  'NOYDB_SHOWCASE_R2_ACCESS_KEY_ID',
  'NOYDB_SHOWCASE_R2_SECRET_ACCESS_KEY',
] as const

/** Cloudflare D1 — REST API (Workers context not required for tests). */
export const D1_GATE_VARS = [
  'NOYDB_SHOWCASE_D1_ACCOUNT_ID',
  'NOYDB_SHOWCASE_D1_DATABASE_ID',
  'NOYDB_SHOWCASE_D1_API_TOKEN',
] as const

/** Postgres — single connection string (`postgres://user:pass@host/db`). */
export const POSTGRES_GATE_VARS = ['NOYDB_SHOWCASE_POSTGRES_URL'] as const

/**
 * Supabase — three values, two purposes.
 *
 * URL + SECRET_KEY drive the @supabase/supabase-js Storage client (blobs).
 * DB_URL drives the Postgres connection (records). Showcase 64 needs DB_URL
 * only; showcase 65 (routed records + blobs + meter) needs all three.
 *
 * Variable names match the labels in Supabase's current dashboard UI:
 * "Project URL", "Secret Key" (the privileged backend key — formerly
 * called service_role), and the "Session pooler" connection string.
 *
 * The default Supabase bucket name `noydb-showcase-blobs` is created by
 * showcase 65 if it doesn't exist yet (no separate bucket-creation step).
 */
export const SUPABASE_DEFAULT_BUCKET = 'noydb-showcase-blobs'
export const SUPABASE_GATE_VARS = [
  'NOYDB_SHOWCASE_SUPABASE_URL',
  'NOYDB_SHOWCASE_SUPABASE_SECRET_KEY',
  'NOYDB_SHOWCASE_SUPABASE_DB_URL',
] as const
/** Records-only gate — needs only the Postgres URL. */
export const SUPABASE_DB_GATE_VARS = ['NOYDB_SHOWCASE_SUPABASE_DB_URL'] as const

/** MySQL — single connection string (`mysql://user:pass@host/db`). */
export const MYSQL_GATE_VARS = ['NOYDB_SHOWCASE_MYSQL_URL'] as const

/** Turso — libSQL URL + auth token. */
export const TURSO_GATE_VARS = [
  'NOYDB_SHOWCASE_TURSO_URL',
  'NOYDB_SHOWCASE_TURSO_AUTH_TOKEN',
] as const

/** WebDAV — URL + basic auth (Nextcloud / ownCloud / Apache mod_dav). */
export const WEBDAV_GATE_VARS = [
  'NOYDB_SHOWCASE_WEBDAV_URL',
  'NOYDB_SHOWCASE_WEBDAV_USERNAME',
  'NOYDB_SHOWCASE_WEBDAV_PASSWORD',
] as const

/** SSH/SFTP — host + port + user + private-key path. */
export const SSH_GATE_VARS = [
  'NOYDB_SHOWCASE_SSH_HOST',
  'NOYDB_SHOWCASE_SSH_USER',
  'NOYDB_SHOWCASE_SSH_KEY_PATH',
  'NOYDB_SHOWCASE_SSH_REMOTE_DIR',
] as const

/** SMB — server + share + user + password. */
export const SMB_GATE_VARS = [
  'NOYDB_SHOWCASE_SMB_SERVER',
  'NOYDB_SHOWCASE_SMB_SHARE',
  'NOYDB_SHOWCASE_SMB_USERNAME',
  'NOYDB_SHOWCASE_SMB_PASSWORD',
] as const

/** NFS — mount path (host-level mount must exist before tests run). */
export const NFS_GATE_VARS = ['NOYDB_SHOWCASE_NFS_MOUNT'] as const

/** iCloud Drive — local path (macOS only; no credential, just path presence). */
export const ICLOUD_GATE_VARS = ['NOYDB_SHOWCASE_ICLOUD_PATH'] as const

/** Google Drive — OAuth refresh token + client id/secret. */
export const DRIVE_GATE_VARS = [
  'NOYDB_SHOWCASE_DRIVE_CLIENT_ID',
  'NOYDB_SHOWCASE_DRIVE_CLIENT_SECRET',
  'NOYDB_SHOWCASE_DRIVE_REFRESH_TOKEN',
] as const
