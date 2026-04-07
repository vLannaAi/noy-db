/**
 * Pure argv parser for `create-noy-db`. Lives in its own module so tests
 * (and other bin wrappers) can import it without triggering the bin's
 * top-level side effects.
 */

import type { WizardAdapter, WizardOptions } from '../wizard/types.js'

export interface ParsedArgs {
  options: WizardOptions
  help: boolean
}

/**
 * Tiny hand-rolled argv parser. Intentionally lightweight — the surface
 * area is three flags and one positional, and we want to keep the
 * install graph for `npm create` as small as possible.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const options: WizardOptions = {}
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '-y' || arg === '--yes') {
      options.yes = true
      continue
    }
    if (arg === '--no-sample-data') {
      options.sampleData = false
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--force-fresh') {
      options.forceFresh = true
      continue
    }
    if (arg === '--adapter') {
      const next = argv[++i]
      if (next !== 'browser' && next !== 'file' && next !== 'memory') {
        throw new Error(
          `--adapter must be one of: browser, file, memory (got: ${next ?? '(missing)'})`,
        )
      }
      options.adapter = next as WizardAdapter
      continue
    }
    if (arg && arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }
    if (arg && !options.projectName) {
      options.projectName = arg
      continue
    }
    if (arg) {
      throw new Error(`Unexpected positional argument: ${arg}`)
    }
  }
  return { options, help }
}
