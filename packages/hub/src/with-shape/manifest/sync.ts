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
 * write that has ALREADY succeeded. If two collections' schema writes race
 * and both try to sync the manifest, the loser's `writeSchemaManifest` call
 * throws {@link ManifestConflictError} against the winner's fresher `_v` —
 * but the loser's own `_schemas/<collection>` write is not rolled back, and
 * the winner's manifest write (if it read a fence/schema state at least as
 * fresh) still reflects the loser's change once it re-derives, or a later
 * sync (the next schema write, or `open()`'s re-derive) will. So a
 * `ManifestConflictError` here is EXPECTED under concurrent sync and is
 * swallowed — the manifest is treated as a derivable cache, not a
 * source of truth, and re-derivation elsewhere converges it. Any OTHER
 * error (store failure, DEK resolution failure, etc.) is NOT swallowed —
 * it propagates to the caller, matching how `persistSchemaIfNeeded`
 * already treats its own write failures as a visible (not silently
 * discarded) fingerprint failure.
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
 * Re-derive the schema manifest and write it if it changed. Swallows a
 * {@link ManifestConflictError} (concurrent sync — see module doc); any
 * other error propagates. Ledger-audits (`op: 'migration'`) only when a
 * write actually happens.
 */
export async function syncSchemaManifest(
  store: NoydbStore,
  vault: string,
  deps: ManifestSyncDeps,
): Promise<void> {
  const derived = await deriveSchemaManifest(store, vault, deps.getDEK)
  const existing = await loadSchemaManifestEntry(store, vault, deps.getDEK)

  if (
    existing &&
    existing.manifest.generation === derived.generation &&
    existing.manifest.aggregateHash === derived.aggregateHash
  ) {
    return // unchanged — no write, no audit
  }

  const expectedVersion = existing?.version ?? 0
  try {
    await writeSchemaManifest(store, vault, derived, expectedVersion, deps.getDEK)
  } catch (err) {
    if (err instanceof ManifestConflictError) return // expected under concurrent sync — see module doc
    throw err
  }

  const ledger = deps.getLedgerOrNull?.()
  if (ledger) {
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
}
