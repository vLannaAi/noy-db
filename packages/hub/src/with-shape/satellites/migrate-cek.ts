/**
 * Satellite per-record-CEK migration (#599) — the R-S7 retro-coverage
 * unblock.
 *
 * R-S7 (`declare.ts:89-91`) correctly refuses declaring/redeclaring a
 * satellite of a forget-covered base without `perRecordKeys: true` — but
 * `perRecordKeys` is construction-only (`kernel/collection.ts:402`), so an
 * app that shipped a satellite BEFORE its base gained forget coverage has
 * no way past the refusal: the existing records must be re-encrypted under
 * fresh per-record CEKs before the satellite can reopen in
 * `perRecordKeys: true` mode, and the only re-encrypt primitive
 * (`Collection._applyCutoverTransform`) needs the collection already
 * constructed in that mode — chicken-and-egg.
 *
 * The break: `Vault.migrateSatellitePerRecordKeys` (`kernel/vault.ts`)
 * opens the satellite collection via `vault.collection(name, {
 * perRecordKeys: true })` WITHOUT `satelliteOf` — that never enters
 * `declareSatellite`, so R-S7's gate (which only fires on the `satelliteOf`
 * declaration path) never runs for the migration pass. R-S7 stays fully
 * enforced for every NORMAL `satelliteOf` declaration; this module and its
 * call-site never touch `declare.ts`.
 *
 * `migrateSatelliteCek` then reuses `_applyCutoverTransform` verbatim (an
 * identity transform — no field/shape change, only the encryption wrapper
 * changes) rather than duplicating its mint-or-reuse-CEK logic
 * (`resolveRecordCek`/`resolveStableCek`, `collection.ts:2537-2545`): a
 * record with no `_cek` yet gets a freshly minted per-record CEK; a record
 * that already carries `_cek` (already migrated, e.g. a prior interrupted
 * run) reuses its existing CEK unchanged. That mint-or-reuse discrimination
 * is what makes re-running this after a mid-migration failure safe for
 * free — no separate resumability marker needed, no double-mint, no
 * plaintext write, no shared-DEK write.
 *
 * **Mode-assertion guard (review Important 1):** `perRecordKeys` is
 * construction-only and the vault's collection cache is first-wins with no
 * mismatch guard. If `coll`'s name was already opened THIS SESSION without
 * `perRecordKeys` (e.g. an incidental bare `vault.collection(name)` call
 * before the migration ran), `vault.collection(name, { perRecordKeys: true
 * })` cache-HITS that instance instead of constructing a fresh one — the
 * returned handle is silently NOT in per-record-CEK mode. Without a check,
 * `_applyCutoverTransform` would then pass `cek: undefined` for every
 * record (`this.perRecordCek` false) and RE-ENCRYPT EVERY RECORD UNDER THE
 * SHARED COLLECTION DEK while still reporting `{ migrated: N }` as success
 * — a security migration that silently mints nothing. `migrateSatelliteCek`
 * reads the opened handle's own `getConfig()` (the same accessor
 * `dumpSchema()` uses) to confirm `perRecordKeys` is genuinely `true`
 * before walking, and throws `SatelliteConfigError` instead of proceeding
 * if not.
 *
 * **No-quiesce precondition (review Important 2):** `_applyCutoverTransform`
 * is documented as fence-phase-only (`collection.ts:2517-2522`) — the
 * generic schema-cutover caller (`Vault.runSchemaCutover` →
 * `SchemaFenceController`) always runs it under the vault-wide schema fence,
 * which blocks concurrent writes. This migration does NOT fence: it calls
 * `_applyCutoverTransform` directly, with no fence and CAS-less
 * (`adapter.put` with no `expectedVersion`) writes. A concurrent write to
 * the same satellite collection racing the walk's `await`s can be
 * clobbered by (or clobber) a migration write. Callers MUST run this before
 * the collection serves traffic — e.g. at v2 boot, before declaring the
 * pair, before any client can write — or otherwise ensure the vault is
 * quiescent for this collection for the duration of the call.
 */
import { SatelliteConfigError } from '../../kernel/errors.js'

/** The narrow slice of `Collection` the migration pass needs (mirrors `fanout.ts`'s `CollectionHandle` narrowing). */
export interface SatelliteCekMigrationTarget {
  /** Public config snapshot (`Collection.getConfig()`) — used to confirm the handle is genuinely in per-record-CEK mode before walking. */
  getConfig(): { readonly perRecordKeys?: boolean } | undefined
  _applyCutoverTransform(transform: (doc: Record<string, unknown>) => Record<string, unknown>): Promise<number>
}

export interface SatelliteCekMigrationResult {
  /** Records touched by this call (both freshly minted and already-migrated re-touches on a resumed run). */
  readonly migrated: number
}

/**
 * Re-encrypt every record in `coll` under a per-record CEK. `coll` must be
 * a collection handle already opened with `perRecordKeys: true` — see the
 * file header for how the caller gets one past R-S7. Throws
 * `SatelliteConfigError` (does NOT proceed) if `coll` is not genuinely in
 * per-record-CEK mode — see the file header's mode-assertion note.
 * Idempotent/resumable: safe to call again after a partial failure. NOT
 * fenced against concurrent writers — see the file header's no-quiesce
 * precondition; run this before the collection serves traffic.
 *
 * @param name The satellite collection's name — used only for the error
 *   message below; identical to what the caller passed to `vault.collection()`.
 */
export async function migrateSatelliteCek(name: string, coll: SatelliteCekMigrationTarget): Promise<SatelliteCekMigrationResult> {
  if (coll.getConfig()?.perRecordKeys !== true) {
    throw new SatelliteConfigError(
      `migrateSatellitePerRecordKeys: collection "${name}" was already opened this session without ` +
      `perRecordKeys (construction-only); migrate before its first open, or restart the session.`,
    )
  }
  // Ledger reason (review Minor): the walk below reuses _applyCutoverTransform's
  // hardcoded 'schema:coordinated-cutover' ledger reason — it has no reason/label
  // param, and this migration is not itself a schema cutover. Not threaded through
  // (would touch collection.ts's own ceilinged surface for a cosmetic label);
  // flagged here so the audit trail's shared reason string is documented, not silent.
  const migrated = await coll._applyCutoverTransform((doc) => doc)
  return { migrated }
}
