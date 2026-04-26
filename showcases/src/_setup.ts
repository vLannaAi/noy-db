/**
 * Vitest setup file — runs once per worker, **before** any test module
 * is imported.
 *
 * Responsibilities:
 *   1. Load the showcase-local `.env` (gitignored). Anything defined there
 *      becomes available to every test via `process.env`.
 *   2. Promote `NOYDB_SHOWCASE_AWS_PROFILE` into the standard `AWS_PROFILE`
 *      env var so the AWS SDK v3 default credential-provider chain resolves
 *      credentials and region from the user's shared-ini config
 *      (~/.aws/credentials + ~/.aws/config) without needing explicit
 *      `fromIni(...)` calls in every cloud showcase.
 *
 * When `.env` is missing the showcase package still works — every cloud
 * showcase uses `describe.skipIf(!AWS_ENABLED)` and simply skips.
 */
import { config as loadEnv } from 'dotenv'

// Loads `showcases/.env` (not root .env) — relative to the vitest CWD,
// which is the package directory.
loadEnv()

if (process.env['NOYDB_SHOWCASE_AWS_PROFILE']) {
  process.env['AWS_PROFILE'] = process.env['NOYDB_SHOWCASE_AWS_PROFILE']
}
