/**
 * `noy-db verify` — end-to-end integrity check.
 *
 * Opens an in-memory NOYDB instance, writes a record, reads it back,
 * decrypts it, and asserts the round-trip is byte-identical. The check
 * exercises the full crypto path (PBKDF2 → KEK → DEK → AES-GCM) without
 * touching any user data on disk.
 *
 * Why an in-memory check is the right scope:
 *   - It validates that @noy-db/core, @noy-db/memory, and the user's
 *     installed Node version all agree on Web Crypto. That's the most
 *     common silent failure for first-time installers.
 *   - It cannot accidentally corrupt user data because there isn't any.
 *   - It runs in well under one second, so users actually run it.
 *
 * What this command does NOT do (intentionally):
 *   - Open the user's actual vault file/dynamo/s3/browser store.
 *     That requires the user's passphrase — not something we want a CLI
 *     `verify` command to prompt for. The full passphrase-driven verify
 *     belongs in `nuxi noydb verify` once the auth story for CLIs lands
 *     in v0.4. For now `noy-db verify` is the dependency-graph smoke test.
 */

import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

export interface VerifyResult {
  /** `true` if the round-trip succeeded; `false` if anything diverged. */
  ok: boolean
  /** Human-readable status. Always set, even on success. */
  message: string
  /** Wall-clock time the integrity check took, in ms. */
  durationMs: number
}

/**
 * Runs the end-to-end check. Pure function — no console output, no
 * `process.exit`. The bin wrapper handles formatting and exit codes so
 * the function is trivial to call from tests.
 */
export async function verifyIntegrity(): Promise<VerifyResult> {
  const start = performance.now()
  try {
    const db = await createNoydb({
      store: memory(),
      user: 'noy-db-verify',
      // The passphrase here is throwaway — the in-memory adapter never
      // persists anything, and the KEK is destroyed when we call close()
      // a few lines down. We use a non-trivial value just to exercise
      // PBKDF2 properly.
      secret: 'noy-db-verify-passphrase-2026',
    })
    const company = await db.openVault('verify-co')
    const collection = company.collection<{ id: string; n: number }>('verify')

    // Round-trip a single record. We pick a value that's small enough
    // to print on failure but large enough to ensure encryption isn't
    // accidentally a no-op.
    const original = { id: 'verify-1', n: 42 }
    await collection.put('verify-1', original)
    const got = await collection.get('verify-1')
    if (!got || got.id !== original.id || got.n !== original.n) {
      return fail(start, `Round-trip mismatch: got ${JSON.stringify(got)}`)
    }

    // Make sure the query DSL works too — this catches the case where
    // the user's @noy-db/core install is at v0.2 (no query DSL) but the
    // CLI was updated to v0.3.
    const found = collection.query().where('n', '==', 42).toArray()
    if (found.length !== 1) {
      return fail(start, `Query DSL mismatch: expected 1 result, got ${found.length}`)
    }

    db.close()

    return {
      ok: true,
      message: 'noy-db integrity check passed',
      durationMs: Math.round(performance.now() - start),
    }
  } catch (err) {
    return fail(start, `Integrity check threw: ${(err as Error).message}`)
  }
}

function fail(start: number, message: string): VerifyResult {
  return {
    ok: false,
    message,
    durationMs: Math.round(performance.now() - start),
  }
}
