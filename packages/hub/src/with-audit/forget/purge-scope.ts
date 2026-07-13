/**
 * #633 — scoped-purge partitioning for the opt-in `scopedPurge` forget-strategy
 * knob (`strategy.ts`'s `SubjectDeclaration.scopedPurge`). Pure helpers only —
 * no store I/O, no `Vault`/`Collection` imports — kept out of `kernel/vault.ts`
 * (exact zero-slack `kernel-surface` ceiling) and free of any circular-import
 * risk with the kernel spine.
 *
 * The two `forget()` purge sites (`_sealed_cek` listing, blob shred) stay
 * UNCONDITIONAL by default (byte-identical to pre-#633 behavior); when
 * `scopedPurge` is `true`, each site calls into this module to decide what to
 * purge vs. what to leave in place + report as residue, keyed off a
 * per-collection declaration signal the caller (vault.ts) resolves itself:
 *   - sealed-CEK arm: `coll._via?.hasAtRestHooks === true` — the classified
 *     via binding's at-rest hooks (the "richer" declaration; a bare
 *     `sensitive` collection with NO classified binder does not count — it can
 *     still call `sealRecordToHost()` ad hoc, which is exactly the
 *     under-approximation #633 calls out).
 *   - blob arm: `this.blobFieldsRegistry.has(ref.collection)` — a collection
 *     can call `.blob(id)` regardless of this declaration (same
 *     under-approximation), which is why the default stays unconditional.
 *
 * @module
 */

/** The two new #633 residue reason strings, reported through the existing
 *  `ForgetResult.scopedPurgeResidue` channel (additive, never a silent skip). */
export type ScopedPurgeResidueReason = 'skipped-undeclared-sealed-cek' | 'skipped-undeclared-blob-scan'

/**
 * Partitions an already-fetched vault-wide `_sealed_cek` key listing into
 * keys to purge vs. a skipped count, for ONE ref's `<collection>/<id>/`
 * prefix. No new store call — `keys` is the SAME listing the unconditional
 * path already fetched. Default parity: when `scopedPurge` is false, or
 * `declared` is true, every matching key is returned for purge and
 * `skippedCount` is 0 — byte-identical to the unconditional behavior.
 */
export function partitionSealedCekKeys(
  keys: readonly string[],
  prefix: string,
  scopedPurge: boolean,
  declared: boolean,
): { readonly toPurge: readonly string[]; readonly skippedCount: number } {
  const matches = keys.filter((key) => key.startsWith(prefix))
  if (!scopedPurge || declared) return { toPurge: matches, skippedCount: 0 }
  return { toPurge: [], skippedCount: matches.length }
}

/**
 * True when the blob arm should skip `ref.collection` entirely — no
 * `.blob(id).shredAllForRecord()` call AND no `_blob_slots_<collection>`
 * residue-detection `list()` call either (the perf win: scoped mode never
 * pays for a per-collection scan on a collection that never declared
 * `blobFields`).
 */
export function shouldSkipBlobScan(scopedPurge: boolean, declared: boolean): boolean {
  return scopedPurge && !declared
}

/** Adds `count` (if positive) to `collection`'s running total in `map` — the
 *  per-collection residue accumulator both purge sites share. */
export function bumpResidueCount(map: Map<string, number>, collection: string, count: number): void {
  if (count > 0) map.set(collection, (map.get(collection) ?? 0) + count)
}

/** Flattens an accumulated per-collection count map into `ForgetResult.scopedPurgeResidue` notices
 *  tagged with `reason`. Empty map → empty array (the unconditional-default case). */
export function residueNoticesFromMap(
  map: ReadonlyMap<string, number>,
  reason: ScopedPurgeResidueReason,
): { readonly reason: ScopedPurgeResidueReason; readonly collection: string; readonly count: number }[] {
  return [...map].map(([collection, count]) => ({ reason, collection, count }))
}
