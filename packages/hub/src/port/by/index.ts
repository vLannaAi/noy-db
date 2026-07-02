/**
 * @noy-db/hub/by — the coordination port for `by-*` transports (the `by-*`
 * family port).
 *
 * A session-share transport (`by-tabs`, `by-peer`) binds ONLY to this
 * subpath: the drain-barrier coordination contract for the schema-fence
 * cutover. `@klum-db/lobby` drives the same port through the `Noydb` handle
 * without ever naming a `by-*` package. `StoreCoordinationProvider` (the
 * store-backed default implementation) lives in `with-shape/schema-update`
 * — its only consumer — and is intentionally NOT exported here.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit
 * and tsup's per-entry bundling keeps class identity stable across subpaths.
 * Supersedes the (already-deprecated) coordination re-exports on `/kernel`.
 */
export { isQuorum, runDrainBarrier } from './types.js'
export type {
  CoordinationProvider,
  WriterPresence,
  FenceState,
  DrainBarrierOptions,
} from './types.js'
