/**
 * Strategy seam between core Collection and the optional CRDT
 * subsystem. Core imports `CrdtStrategy` as a TYPE-ONLY symbol and
 * `NO_CRDT` as a minimal runtime stub.
 *
 * The state-construction / merge / snapshot-resolution helpers —
 * `buildLwwMapState`, `buildRgaState`, `mergeCrdtStates`,
 * `resolveCrdtSnapshot` — are only reachable from `withCrdt()` in
 * `./active.ts`, which is only exported through the `@noy-db/hub/crdt`
 * subpath. Consumers without CRDT mode configured never pull the
 * ~221 LOC into their bundle.
 *
 * @internal
 */

import type { CrdtState, LwwMapState, RgaState } from './crdt.js'

/**
 * Seam interface. `@internal`.
 *
 * @internal
 */
export interface CrdtStrategy {
  buildLwwMapState(
    record: Record<string, unknown>,
    previous: LwwMapState | undefined,
    now: string,
  ): LwwMapState
  buildRgaState(
    items: readonly unknown[],
    previous: RgaState | undefined,
    idGen: () => string,
  ): RgaState
  mergeCrdtStates(local: CrdtState, remote: CrdtState): CrdtState
  resolveCrdtSnapshot(state: CrdtState): unknown
}

const NOT_ENABLED = new Error(
  'CRDT mode requires the CRDT strategy. Import `{ withCrdt }` from ' +
  '"@noy-db/hub/crdt" and pass it to `createNoydb({ crdtStrategy: withCrdt() })`.',
)

/**
 * No-CRDT stub. Every method throws with a pointer at the subpath.
 * If a Collection declares `crdt: '...'` without this strategy wired,
 * the first put/sync-merge/read that hits the CRDT path surfaces the
 * error immediately.
 *
 * @internal
 */
export const NO_CRDT: CrdtStrategy = {
  buildLwwMapState() { throw NOT_ENABLED },
  buildRgaState() { throw NOT_ENABLED },
  mergeCrdtStates() { throw NOT_ENABLED },
  resolveCrdtSnapshot() { throw NOT_ENABLED },
}
