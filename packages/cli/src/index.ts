/**
 * **@noy-db/cli** — programmatic API for the `noydb` CLI.
 *
 * The CLI is primarily used via the `noydb` executable (installed as
 * a bin when this package is installed), but every subcommand is
 * also exposed as a function for programmatic use inside tests,
 * scripts, or custom wrappers.
 *
 * ```ts
 * import { inspect, verify, validateOptions, scaffold } from '@noy-db/cli'
 *
 * const header  = await inspect('backup.noydb')
 * const report  = await verify('backup.noydb')
 * const issues  = validateOptions(myNoydbOptions)
 * const profile = scaffold('C')
 * ```
 *
 * @packageDocumentation
 */

export { inspect, runInspect } from './commands/inspect.js'
export type { InspectResult } from './commands/inspect.js'

export { verify, runVerify } from './commands/verify.js'
export type { VerifyReport } from './commands/verify.js'

export {
  validateOptions,
  loadOptionsFromFile,
  scaffold,
  runConfigValidate,
  runConfigScaffold,
} from './commands/config.js'
export type {
  ValidationIssue,
  ValidationReport,
  ScaffoldResult,
  Profile,
} from './commands/config.js'

export { runMonitor, formatSnapshot } from './commands/monitor.js'
export type { MonitorOptions } from './commands/monitor.js'
