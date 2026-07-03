/**
 * Strategy seam between core Collection and the optional CRDT
 * service. Core imports `CrdtStrategy` as a TYPE-ONLY symbol and
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

// Hoisted to kernel/types.ts (C3 — enclave self-containment: record-codec.ts
// consumes this as a spine-owned contract type). Re-exported here so existing
// importers of this module are unaffected.
import type { CrdtStrategy } from '../../kernel/types.js'
export type { CrdtStrategy } from '../../kernel/types.js'

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
