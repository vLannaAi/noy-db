/**
 * #1458 — the Live install. See `../relate/install.ts` for why this is a
 * function called from the entry rather than a module-level side effect.
 */
import { Query } from '../builder.js'
import { installMethods } from '../internal/core.js'
import { MaintenanceMethods } from '../internal/maintenance.js'
import { LiveMethods } from './methods.js'

let done = false

/** Idempotent: the root barrel and the subpath entry both call it. */
export function installLive(): void {
  if (done) return
  done = true
  installMethods(Query.prototype, MaintenanceMethods)
  installMethods(Query.prototype, LiveMethods)
}
