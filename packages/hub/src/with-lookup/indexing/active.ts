/**
 * Active indexing strategy factory. Calling `withIndexing()` returns
 * an `IndexingStrategy` whose `createState` constructs a real
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
import type { IndexingStrategy, IndexState } from './strategy.js'

/**
 * Build the default indexing strategy. Pass into
 * `createNoydb({ indexingStrategy: withIndexing() })` to light up the
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
 *   indexingStrategy: withIndexing(),
 * })
 * ```
 */
export function withIndexing(): IndexingStrategy {
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
          // `kind: 'sorted'` (#1344) additionally builds the ordered array
          // that drives `<`/`>`/`between`/`startsWith`/`orderBy+limit`. The
          // hash index is declared either way, so `==`/`in` stay O(1).
          const obj = def as { fields: readonly string[]; kind?: 'hash' | 'sorted' }
          for (const f of obj.fields) {
            eager.declare(f)
            if (obj.kind === 'sorted') eager.declareSorted(f)
          }
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
    } else {
      const fields = Array.isArray(def) ? (def as readonly string[]) : (def as { fields: readonly string[] }).fields
      // #698: decompose a composite into its component single-field indexes
      // (like the eager branch above), so a composite-only declaration still
      // provides the single-field driver the #696 Via-covered fall-through
      // and single-field queries need. The composite mirror is kept for the
      // multi-field fast path.
      for (const f of fields) persisted.declare(f)
      persisted.declareComposite(fields)
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
