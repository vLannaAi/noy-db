/**
 * #1458 — the Reduce install. See `../relate/install.ts` for why this is a
 * function called from the entry rather than a module-level side effect.
 */
import { Query } from '../builder.js'
import { ScanBuilder } from '../scan-builder.js'
import { installMethods } from '../internal/core.js'
import { MaintenanceMethods } from '../internal/maintenance.js'
import { ReduceMethods } from './methods.js'
import { ScanReduceMethods } from './scan-methods.js'

let done = false

/** Idempotent: the root barrel and the subpath entry both call it. */
export function installReduce(): void {
  if (done) return
  done = true
  installMethods(Query.prototype, MaintenanceMethods)
  installMethods(Query.prototype, ReduceMethods)
  installMethods(ScanBuilder.prototype, ScanReduceMethods)
}
