/**
 * @noy-db/hub/with — the seam `with*()` services hook into.
 *
 * Carries the three primitives every opt-in service is built on top of: the
 * `ServiceBus` (observe/gate lifecycle bus; `SubsystemBus` is a deprecated
 * alias kept for source compat), the `WriteHookRegistry`
 * (before/after write hooks), and the export/import capability gate
 * (`assertCanExport`/`assertCanImport`/`canExport`/`canImport`). This subpath
 * is the stable, named door onto them.
 *
 * Named re-exports only (no `export *`) so the published surface is explicit and
 * tsup's per-entry bundling keeps class identity stable across subpaths.
 */
export type {
  WriteEvent,
  WriteHook,
  Unsubscribe,
} from './write-hooks.js'
export { WriteHookRegistry } from './write-hooks.js'

export type {
  LifecycleEventMap,
  LifecyclePoint,
  BusHandler,
  GatePutEvent,
  GateDeleteEvent,
  GateEventMap,
  GatePoint,
  GateHandler,
} from './service-bus.js'
export { ServiceBus, SubsystemBus } from './service-bus.js'

export {
  assertCanExport,
  assertCanImport,
  canExport,
  canImport,
} from './capabilities.js'
