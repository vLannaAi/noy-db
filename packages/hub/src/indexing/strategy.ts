/**
 * Strategy seam between core Collection and the optional indexing
 * subsystem. Core imports `IndexStrategy` and `IndexState` as
 * TYPE-ONLY symbols and `NO_INDEXING` as a tiny runtime stub.
 *
 * The heavy classes — `CollectionIndexes`, `PersistedCollectionIndex`,
 * `LazyQuery` — are only instantiated inside the `withIndexing()`
 * factory under `./active.ts`, which in turn is only reachable through
 * the `@noy-db/hub/indexing` subpath export. A consumer that never
 * imports the subpath ships none of those classes in their bundle
 * (ESM tree-shaking + hub's `"sideEffects": false`).
 *
 * @internal
 */

import type { CollectionIndexes, IndexDef } from './eager-indexes.js'
import type { PersistedCollectionIndex } from './persisted-indexes.js'

/**
 * Per-collection container for whatever mirrors the active strategy
 * decided to materialize. Both accessors may return `null` — they do
 * for `NO_INDEXING`, and `getEagerIndexes` returns null in a
 * lazy-mode collection even when indexing is active (lazy uses the
 * persisted mirror instead).
 *
 * `isEnabled` is a cheap guard so collection code can short-circuit
 * the full indexing path without inspecting either mirror.
 *
 * @internal
 */
export interface IndexState {
  readonly isEnabled: boolean
  getEagerIndexes(): CollectionIndexes | null
  getPersistedIndexes(): PersistedCollectionIndex | null
}

/**
 * Factory that builds one `IndexState` per Collection. Called exactly
 * once inside each Collection constructor with the declared
 * `IndexDef[]` and the lazy-mode flag (so lazy collections get the
 * persisted mirror and eager collections get the in-memory one).
 *
 * @internal
 */
export interface IndexStrategy {
  createState(args: {
    readonly defs: readonly IndexDef[]
    readonly lazy: boolean
  }): IndexState
}

/**
 * No-indexing stub. Every Collection defaults to this; it returns a
 * cheap `IndexState` whose mirrors are both `null`. Collection code
 * null-checks both accessors and short-circuits, so no indexing code
 * path runs and the heavy classes never arrive in the bundle.
 *
 * @internal
 */
export const NO_INDEXING: IndexStrategy = {
  createState() {
    return DISABLED_STATE
  },
}

const DISABLED_STATE: IndexState = {
  isEnabled: false,
  getEagerIndexes: () => null,
  getPersistedIndexes: () => null,
}
