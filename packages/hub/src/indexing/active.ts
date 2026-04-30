/**
 * Active indexing strategy factory. Calling `withIndexing()` returns
 * an `IndexStrategy` whose `createState` constructs a real
 * `CollectionIndexes` (eager) or `PersistedCollectionIndex` (lazy)
 * per Collection, depending on the collection's `prefetch` mode and
 * its declared `IndexDef[]`.
 *
 * This module is only reachable through the `@noy-db/hub/indexing`
 * subpath — a consumer that never imports the subpath ships none of
 * this (ESM tree-shaking + hub's `"sideEffects": false`).
 */

import { CollectionIndexes } from './eager-indexes.js'
import type { IndexDef } from './eager-indexes.js'
import { PersistedCollectionIndex } from './persisted-indexes.js'
import type { IndexStrategy, IndexState } from './strategy.js'

/**
 * Build the default indexing strategy. Pass into
 * `createNoydb({ indexStrategy: withIndexing() })` to light up the
 * eager-mode `==/in` fast-path on `.query()` and the full lazy-mode
 * `.lazyQuery()` + rebuild / reconcile / auto-reconcile surface.
 *
 * @example
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { withIndexing } from '@noy-db/hub/indexing'
 *
 * const db = await createNoydb({
 *   store, user, secret,
 *   indexStrategy: withIndexing(),
 * })
 * ```
 */
export function withIndexing(): IndexStrategy {
  return {
    createState({ defs, lazy }) {
      if (lazy) {
        const persisted = new PersistedCollectionIndex()
        declareAll(persisted, defs)
        return makeLazyState(persisted)
      }
      const eager = new CollectionIndexes()
      for (const def of defs) {
        if (typeof def === 'string') {
          eager.declare(def)
        } else if (Array.isArray(def)) {
          for (const f of def as readonly string[]) eager.declare(f)
        } else {
          for (const f of (def as { fields: readonly string[] }).fields) eager.declare(f)
        }
      }
      return makeEagerState(eager)
    },
  }
}

function declareAll(persisted: PersistedCollectionIndex, defs: readonly IndexDef[]): void {
  for (const def of defs) {
    if (typeof def === 'string') {
      persisted.declare(def)
    } else if (Array.isArray(def)) {
      persisted.declareComposite(def as readonly string[])
    } else {
      persisted.declareComposite((def as { fields: readonly string[] }).fields)
    }
  }
}

function makeEagerState(eager: CollectionIndexes): IndexState {
  return {
    isEnabled: true,
    getEagerIndexes: () => eager,
    getPersistedIndexes: () => null,
  }
}

function makeLazyState(persisted: PersistedCollectionIndex): IndexState {
  return {
    isEnabled: true,
    getEagerIndexes: () => null,
    getPersistedIndexes: () => persisted,
  }
}
