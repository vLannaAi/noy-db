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
 * The synthesized ref is INTERLEAVED into the SAME list the caller iterates —
 * immediately BEFORE its base ref, not appended after the whole list — so it
 * traverses every purge stage below the tombstone (history, `_idx`/`_ftindex`,
 * blobs, `_sealed`/`_sealed_cek`, vectors) identically to a base ref — there
 * is no separate satellite-only code path.
 *
 * Ordering is load-bearing (retry black hole, #591 review C1): `vault.forget()`'s
 * per-ref loop removes each ref's subject-index entry (the retry anchor) only
 * at the END of that ref's own iteration. If the satellite ref instead ran
 * AFTER its base ref (as a simple append), an R-S4 abort mid-satellite-ref (or
 * a crash) would leave the base ref already fully processed — including its
 * subject-index entry already removed — so a retried `forget(subjectId)` finds
 * nothing to resolve and returns a clean, empty result while the satellite's
 * heavy data stays un-shredded forever. Interleaving the satellite ref BEFORE
 * its base ref means any R-S4 abort happens before the base's subject-index
 * anchor is touched, so a retry re-discovers the same base ref (and
 * re-synthesizes its satellite ref) until both actually shred.
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
  const out: Array<SubjectRef | SatelliteSubjectRef> = []
  let anySat = false
  for (const ref of refs) {
    const spec = registry.satelliteOf(ref.collection)
    if (spec) {
      anySat = true
      out.push({ collection: spec.satellite, id: ref.id, satelliteOf: ref.collection })
    }
    out.push(ref)
  }
  return anySat ? out : refs
}
