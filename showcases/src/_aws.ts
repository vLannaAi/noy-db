/**
 * Shared AWS wiring for the cloud showcases (#10, #11).
 *
 * Credentials + region come from the AWS profile named in
 * `NOYDB_SHOWCASE_AWS_PROFILE` (loaded from `showcases/.env` by
 * `_setup.ts`). The profile is promoted to the standard `AWS_PROFILE`
 * env var, so every AWS SDK v3 client constructed here uses the SDK's
 * default credential-provider chain — nothing in this file touches
 * `fromIni` or `~/.aws/credentials` directly.
 *
 * When no profile is set, `AWS_ENABLED` is false and every cloud showcase
 * skips via `describe.skipIf(!AWS_ENABLED)`. The non-cloud tests in the
 * same suite still run to completion.
 */

import type { NoydbStore } from '@noy-db/hub'

// ─── Config (read once at module load) ───────────────────────────────────

/** AWS profile name from `.env`, or `undefined` when unset. */
export const AWS_PROFILE = process.env['NOYDB_SHOWCASE_AWS_PROFILE']

/** True only when a profile is configured — the gate for every cloud showcase. */
export const AWS_ENABLED = Boolean(AWS_PROFILE)

/**
 * Cleanup mode. Defaults to ON — tests delete records they wrote.
 * Set `NOYDB_SHOWCASE_AWS_CLEANUP=0` in `.env` to leave records in place
 * for post-mortem inspection.
 */
export const AWS_CLEANUP = process.env['NOYDB_SHOWCASE_AWS_CLEANUP'] !== '0'

/** DynamoDB table name. Must match the CFN stack's output. */
export const DYNAMO_TABLE =
  process.env['NOYDB_SHOWCASE_DYNAMO_TABLE'] ?? 'noydb-showcase'

/** S3 bucket name. Must match the CFN stack's output. */
export const S3_BUCKET =
  process.env['NOYDB_SHOWCASE_S3_BUCKET'] ?? 'noydb-showcase-blobs'

/**
 * Per-run identifier — appended to vault names so concurrent test runs
 * against the same AWS account can't collide. Recomputed per module load
 * (i.e. per test worker).
 */
export const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// ─── Skip-hint helper ────────────────────────────────────────────────────

/**
 * Print a one-line hint at module-load time so developers scrolling vitest
 * output know exactly how to enable a skipped cloud showcase. Quietly
 * no-ops when the profile is set (the showcase is about to run).
 */
export function logSkipHint(label: string): void {
  if (!AWS_ENABLED) {
    // eslint-disable-next-line no-console
    console.info(
      `[${label}] Skipping — set NOYDB_SHOWCASE_AWS_PROFILE in showcases/.env to run this showcase against real AWS.`,
    )
  }
}

// ─── Cleanup helper ──────────────────────────────────────────────────────

/**
 * Tear down every known collection a showcase may have written to in a
 * vault. Safe to call from `afterAll` — honours `AWS_CLEANUP=0` (no-op)
 * and swallows individual per-item failures so one stuck delete doesn't
 * leave the rest of the vault behind.
 *
 * `collections` should include both application collections (like
 * `'invoices'`) and the NOYDB system collections the test touched
 * (`'_keyring'`, `'_sync'`, and any `_blob_*` families). The caller
 * knows which collections they produced; we don't try to infer.
 */
export async function cleanupVault(options: {
  label: string
  vault: string
  stores: Array<{ store: NoydbStore; collections: string[] }>
}): Promise<void> {
  if (!AWS_CLEANUP) {
    // eslint-disable-next-line no-console
    console.info(
      `[${options.label}] AWS_CLEANUP=0 — leaving vault "${options.vault}" in place for inspection.`,
    )
    return
  }

  for (const { store, collections } of options.stores) {
    for (const coll of collections) {
      let ids: string[]
      try {
        ids = await store.list(options.vault, coll)
      } catch {
        // Collection may not exist on this store — e.g. `_blob_chunks`
        // lives in S3 but not DynamoDB when using a split-store route.
        continue
      }
      for (const id of ids) {
        await store.delete(options.vault, coll, id).catch(() => {
          /* best effort — one stuck item shouldn't block the rest */
        })
      }
    }
  }
}
