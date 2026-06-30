/**
 * Active CRDT strategy factory. Calling `withCrdt()` returns a
 * `CrdtStrategy` whose methods delegate to the real LWW-Map / RGA /
 * merge / snapshot helpers in `./crdt.ts`. Only reachable through
 * the `@noy-db/hub/crdt` subpath.
 */

import {
  buildLwwMapState,
  buildRgaState,
  mergeCrdtStates,
  resolveCrdtSnapshot,
} from './crdt.js'
import type { CrdtStrategy } from './strategy.js'

/**
 * Build the default CRDT strategy. Pass into
 * `createNoydb({ crdtStrategy: withCrdt() })` to enable collections
 * declared with `crdt: 'lww-map' | 'rga' | 'yjs'`.
 *
 * @example
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { withCrdt } from '@noy-db/hub/crdt'
 *
 * const db = await createNoydb({
 *   store, user, secret,
 *   crdtStrategy: withCrdt(),
 * })
 * const notes = vault.collection('notes', { crdt: 'lww-map' })
 * ```
 */
export function withCrdt(): CrdtStrategy {
  return {
    buildLwwMapState,
    buildRgaState,
    mergeCrdtStates,
    resolveCrdtSnapshot,
  }
}
