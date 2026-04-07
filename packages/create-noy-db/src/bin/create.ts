#!/usr/bin/env node
/**
 * The `create` bin of `@noy-db/create`. Invoked by the scoped-initializer
 * idioms `npm create @noy-db`, `pnpm create @noy-db`, `yarn create @noy-db`,
 * and `bun create @noy-db`.
 *
 * Why the bin is called `create` (no suffix): npm's `npm init @scope` is
 * sugar for `npm exec @scope/create`, and `npm exec` picks the bin whose
 * name matches the package's "stripped" name. For `@noy-db/create` that's
 * literally `create`. If we named the bin anything else, the shortcut
 * `npm create @noy-db` would break.
 *
 * Argument convention follows the de-facto standard for `create-*` tools:
 * the first positional argument (if any) becomes the project name. Flags:
 *
 *   --yes / -y           Skip every prompt; use defaults for missing values
 *   --adapter <name>     Pre-select adapter (browser | file | memory)
 *   --no-sample-data     Don't include the seed invoices
 *   --help / -h          Print usage and exit 0
 *
 * The bin is intentionally tiny: it parses argv, calls `runWizard`, and
 * exits with the right code. Everything else lives in the wizard module
 * so it's reusable from tests and from other tooling.
 */

import * as p from '@clack/prompts'
import pc from 'picocolors'
import { runWizard } from '../wizard/run.js'
import { parseArgs, type ParsedArgs } from './parse-args.js'

const HELP = `Usage: npm create @noy-db [project-name] [options]

Options:
  -y, --yes               Skip prompts; use defaults for missing values
      --adapter <name>    Adapter: browser (default) | file | memory
      --no-sample-data    Skip the seed invoice records
  -h, --help              Show this message and exit

Examples:
  npm create @noy-db                          # interactive
  npm create @noy-db my-app                   # name supplied, prompts for the rest
  npm create @noy-db my-app --yes             # everything from defaults
  npm create @noy-db my-app --adapter file    # pick the file adapter
  pnpm create @noy-db my-app                  # or use your favourite pm
`

async function main(): Promise<void> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n\n${HELP}`)
    process.exit(2)
    return // unreachable, but narrows `parsed` for the type checker
  }

  if (parsed.help) {
    process.stdout.write(HELP)
    return
  }

  // Only run the intro/outro decorations in interactive mode. Tests
  // call `runWizard` directly and shouldn't see these.
  if (!parsed.options.yes) {
    p.intro(pc.bgCyan(pc.black(' @noy-db/create ')))
    p.note(
      'A wizard for noy-db — None Of Your Damn Business.\nGenerates a fresh Nuxt 4 + Pinia + encrypted-store starter.',
    )
  }

  try {
    await runWizard(parsed.options)
  } catch (err) {
    p.cancel((err as Error).message)
    process.exit(1)
  }
}

void main()
