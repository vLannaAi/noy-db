/**
 * @noy-db/hub/crdt — opt-in CRDT (conflict-free replicated data type)
 * subsystem.
 *
 * @category capability
 *
 * Collaborative-editing primitives: LWW-Map, RGA (sequence CRDT), and
 * a Yjs bridge state shape. Enabled per-collection via
 * `collection(name, { crdt: 'lww-map' | 'rga' | 'yjs' })`. Apps that
 * stick to plain record-level last-write-wins can omit this subpath
 * and save ~221 LOC of state / merge / snapshot helpers.
 */

export { withCrdt } from './active.js'
export type { CrdtStrategy } from './strategy.js'

export {
  resolveCrdtSnapshot,
  mergeCrdtStates,
  buildLwwMapState,
  buildRgaState,
} from './crdt.js'
export type {
  CrdtMode,
  CrdtState,
  LwwMapState,
  RgaState,
  YjsState,
} from './crdt.js'
