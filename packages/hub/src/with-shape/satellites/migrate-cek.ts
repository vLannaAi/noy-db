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
 */

/** The narrow slice of `Collection` the migration pass needs (mirrors `fanout.ts`'s `CollectionHandle` narrowing). */
export interface SatelliteCekMigrationTarget {
  _applyCutoverTransform(transform: (doc: Record<string, unknown>) => Record<string, unknown>): Promise<number>
}

export interface SatelliteCekMigrationResult {
  /** Records touched by this call (both freshly minted and already-migrated re-touches on a resumed run). */
  readonly migrated: number
}

/**
 * Re-encrypt every record in `coll` under a per-record CEK. `coll` must be
 * a collection handle already opened with `perRecordKeys: true` — see the
 * file header for how the caller gets one past R-S7. Idempotent/resumable:
 * safe to call again after a partial failure.
 */
export async function migrateSatelliteCek(coll: SatelliteCekMigrationTarget): Promise<SatelliteCekMigrationResult> {
  const migrated = await coll._applyCutoverTransform((doc) => doc)
  return { migrated }
}
