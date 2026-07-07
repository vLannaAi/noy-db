/**
 * Forget fan-out (#591, Task 8): expands the base refs resolved from the
 * encrypted subject index with a synthesized same-id ref for every base ref
 * whose collection has a declared satellite.
 *
 * A satellite record is NEVER itself indexed in `_subject_index` (its writes
 * only ever go through `joinedPut`, which never touches the subject-field
 * write hook — see `noydb.ts#registerForgetHooks`), so `lookupSubject` alone
 * would leave the satellite half of a pair permanently un-erasable. The
 * synthesized ref carries `satelliteOf` (the base collection name) so:
 *   - `vault.forget()`'s classification line can inherit `perRecordKeys`
 *     from the BASE's forget-strategy entry (the satellite itself is never a
 *     `subjects` key), and
 *   - the synthesized ref's tombstone write can be held to R-S4 fail-loud
 *     semantics distinct from a base ref's existing resilient handling.
 *
 * The synthesized ref is appended to the SAME list the caller iterates, so it
 * traverses every purge stage below the tombstone (history, `_idx`/`_ftindex`,
 * blobs, `_sealed`/`_sealed_cek`, vectors) identically to a base ref — there
 * is no separate satellite-only code path.
 */
import type { SubjectRef } from '../../with-audit/forget/subject-index.js'
import type { SatelliteRegistry } from './registry.js'

/** A subject ref synthesized from a base ref via a declared satellite pairing. */
export interface SatelliteSubjectRef extends SubjectRef {
  readonly satelliteOf: string
}

/**
 * Expand `refs` (as resolved by `lookupSubject`) with one synthesized ref per
 * base ref whose collection has a registered satellite. `registry` may be
 * `null` (no satellite ever declared in this vault) — returns `refs`
 * unchanged, byte-identical to pre-#591 behaviour.
 */
export function expandRefsWithSatellites(
  refs: readonly SubjectRef[],
  registry: SatelliteRegistry | null,
): ReadonlyArray<SubjectRef | SatelliteSubjectRef> {
  if (registry === null) return refs
  const satRefs: SatelliteSubjectRef[] = []
  for (const ref of refs) {
    const spec = registry.satelliteOf(ref.collection)
    if (spec) satRefs.push({ collection: spec.satellite, id: ref.id, satelliteOf: ref.collection })
  }
  return satRefs.length === 0 ? refs : [...refs, ...satRefs]
}
