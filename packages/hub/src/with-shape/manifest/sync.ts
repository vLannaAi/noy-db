/**
 * Keep the persisted `_manifest/schema` record in sync with the
 * per-collection `_schemas/<collection>` source of truth (#941 Task 3).
 *
 * Called from `persisted-schemas/register.ts`'s `persistSchemaIfNeeded`
 * right after a `_schemas/<collection>` write succeeds.
 *
 * ## Reconciling strict-CAS-refuse with the derived nature of the manifest
 *
 * `writer.ts`'s `writeSchemaManifest` is deliberately strict-CAS: a
 * concurrent *direct* edit to the manifest is refused, never retried (AC
 * #1). But this call site is not a direct edit — it is a re-derivation
 * from the source of truth, triggered as a side effect of a `_schemas`
 * write that has ALREADY succeeded. When N collections are declared
 * together (one `openVault()` call registering several `persistJsonSchema:
 * true` collections), their `persistSchemaIfNeeded` calls run CONCURRENTLY
 * — each one's own `_schemas/<collection>` write lands independently, and
 * each then calls this function. A single derive-then-write with no
 * feedback loop is NOT enough here: a call whose `deriveSchemaManifest`
 * snapshot ran before a sibling's `_schemas` write landed would persist a
 * manifest that's missing that sibling forever (nothing re-triggers it) —
 * this was a REAL bug (not a test-isolation artifact — reproduced with 0
 * shared state, purely from concurrent `_schemas` writes racing the derive
 * snapshot; see #941 flake fix commit). `syncSchemaManifest` therefore
 * loops (bounded by {@link MAX_SYNC_ATTEMPTS}):
 *
 *   1. Derive fresh, compare to what's persisted. Already converged → done.
 *   2. Write via strict-CAS. `ManifestConflictError` (another writer moved
 *      the manifest first) → loop: re-derive against the NEW state and
 *      retry, exactly like a normal optimistic-CAS retry.
 *   3. On a successful write, derive ONE more time. If a sibling's
 *      `_schemas` write landed while we were deriving/writing, the state
 *      has already moved past what we just wrote — loop again to catch it
 *      up. If the re-derive matches what we wrote, we're the last writer
 *      and the manifest is provably converged: return.
 *
 * This guarantees that whichever collection's `_schemas` write is the LAST
 * to land (in real wall-clock order — there is always exactly one, even
 * though no single caller knows which) ends up running a sync whose own
 * derive sees every sibling's write already committed, and whose
 * recheck-after-write confirms nothing moved further — so it converges the
 * manifest deterministically, regardless of interleaving. If attempts are
 * exhausted under pathological contention, the loop gives up — with a
 * `console.warn` (see cap-exhaustion note below), not silently — leaving
 * the last successful write in place; the manifest is a derivable cache
 * (not a correctness invariant), so a next schema write or `open()`'s
 * re-derive still converges it, matching how `persistSchemaIfNeeded`
 * already treats its own write failures.
 * Any error OTHER than `ManifestConflictError` (store failure, DEK
 * resolution failure, etc.) is NOT swallowed — it propagates to the
 * caller immediately, matching how `persistSchemaIfNeeded` already treats
 * its own write failures as a visible (not silently discarded) fingerprint
 * failure.
 *
 * ## Ledger audit (AC #5)
 *
 * Schema-generation transitions are not ledger-audited anywhere else today
 * (neither the `_schemas/<collection>` write in `register.ts` nor the fence
 * bump in `schema-update/fence-controller.ts#runCutover`). This is the
 * first ledger-audited signal for a schema change: every manifest write
 * that actually happens (i.e. every time the derived manifest differs from
 * what's stored) appends an `op: 'migration'` entry via the optional
 * `getLedgerOrNull` callback — `null`/absent when the history strategy
 * isn't opted in, matching every other optional-ledger call site
 * (`vault._getLedgerOrNull()?.append(...)`, see `liberate.ts`,
 * `with-audit/periods/vault-facade.ts`). No audit fires on the no-op path
 * (derived manifest unchanged) or on a swallowed conflict (the winning
 * writer's own sync already audits its write).
 *
 * @module
 */

import type { LedgerStore } from '../../with-commit/history/ledger/store.js'
import { envelopePayloadHash } from '../../with-commit/history/ledger/hash.js'
import type { NoydbStore } from '../../kernel/types.js'
import { ManifestConflictError } from '../../kernel/errors.js'
import { deriveSchemaManifest } from './derive.js'
import { loadSchemaManifestEntry, type GetManifestDEK } from './storage.js'
import { writeSchemaManifest } from './writer.js'
import { MANIFEST_COLLECTION } from './reserved-collections.js'
import { MANIFEST_SCHEMA_RECORD_ID } from './types.js'

export interface ManifestSyncDeps {
  /** Resolver for any collection's DEK (both the `_schemas/<c>` entries and `_manifest` itself). */
  readonly getDEK: GetManifestDEK
  /** Optional ledger handle — absent when the history strategy isn't opted in (no-op audit). */
  readonly getLedgerOrNull?: () => LedgerStore | null
}

/**
 * Bound on the derive→write→recheck loop (see module doc). Headroom above
 * what any realistic `openVault()` batch (a handful of collections) needs —
 * a 40-way concurrent-declare stress repro converged within single digits.
 */
const MAX_SYNC_ATTEMPTS = 16

/**
 * Re-derive the schema manifest and write it if it changed, looping until
 * the write is provably stable against concurrent sibling `_schemas`
 * writes (see module doc). Swallows a {@link ManifestConflictError} by
 * retrying against the fresher state; any other error propagates.
 * Ledger-audits (`op: 'migration'`) once per successful write.
 */
export async function syncSchemaManifest(
  store: NoydbStore,
  vault: string,
  deps: ManifestSyncDeps,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt++) {
    const derived = await deriveSchemaManifest(store, vault, deps.getDEK)
    const existing = await loadSchemaManifestEntry(store, vault, deps.getDEK)

    if (
      existing &&
      existing.manifest.generation === derived.generation &&
      existing.manifest.aggregateHash === derived.aggregateHash
    ) {
      return // already converged — no write, no audit
    }

    const expectedVersion = existing?.version ?? 0
    try {
      await writeSchemaManifest(store, vault, derived, expectedVersion, deps.getDEK)
    } catch (err) {
      if (err instanceof ManifestConflictError) continue // another writer moved it first — re-derive + retry
      throw err
    }

    await auditManifestWrite(store, vault, deps, derived, expectedVersion)

    // A sibling's `_schemas` write can land while WE were deriving/writing
    // (#941 flake fix — see module doc). Re-derive once more: if the truth
    // has already moved past what we just wrote, loop again to catch it up
    // instead of leaving a permanently-partial manifest.
    const recheck = await deriveSchemaManifest(store, vault, deps.getDEK)
    if (recheck.generation === derived.generation && recheck.aggregateHash === derived.aggregateHash) {
      return // stable — we were the last writer
    }
  }
  // Attempts exhausted under pathological contention — see module doc:
  // the manifest is a derivable cache, not a correctness invariant, so a
  // later schema write or open()'s re-derive still converges it. Warn
  // rather than fail silently — a silent give-up on a completeness
  // invariant is exactly what hid the original concurrent-declare race.
  console.warn(
    `[noy-db] schema-manifest sync did not converge after ${MAX_SYNC_ATTEMPTS} attempts; ` +
      'the persisted manifest may be stale until the next schema write or open()\'s re-derive.',
  )
}

async function auditManifestWrite(
  store: NoydbStore,
  vault: string,
  deps: ManifestSyncDeps,
  derived: Awaited<ReturnType<typeof deriveSchemaManifest>>,
  expectedVersion: number,
): Promise<void> {
  const ledger = deps.getLedgerOrNull?.()
  if (!ledger) return
  // `_manifest/schema` has a real, individually-addressable envelope (unlike
  // a `lifecycle` entry's empty collection/id) — `verifyBackupIntegrity`'s
  // data cross-check (`with-pod/backup.ts`) treats any non-amendment,
  // non-lifecycle entry's `collection`/`id` as "the latest write to this
  // record" and recomputes+compares its ciphertext hash, so `payloadHash`
  // must be the real `envelopePayloadHash` of the just-written envelope
  // (ciphertext domain), NOT `derived.aggregateHash` (plaintext domain) —
  // using the wrong domain here trips a false-positive tamper failure on
  // restore.
  const envelope = await store.get(vault, MANIFEST_COLLECTION, MANIFEST_SCHEMA_RECORD_ID)
  await ledger.append({
    op: 'migration',
    collection: MANIFEST_COLLECTION,
    id: MANIFEST_SCHEMA_RECORD_ID,
    version: expectedVersion + 1,
    actor: '',
    payloadHash: await envelopePayloadHash(envelope),
    reason: `schema-manifest-sync:generation=${derived.generation}`,
  })
}
