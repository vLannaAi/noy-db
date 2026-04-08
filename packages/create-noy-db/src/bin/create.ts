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
import { detectLocale, loadMessages } from '../wizard/i18n/index.js'

const HELP = `Usage: npm create @noy-db [project-name] [options]

The wizard auto-detects whether cwd is an existing Nuxt 4 project:

  - If nuxt.config.{ts,js,mjs} + a package.json with \`nuxt\` in
    deps are both present, it enters AUGMENT mode — patches the
    existing config via magicast, shows a unified diff, and asks
    for confirmation before writing.

  - Otherwise it enters FRESH mode — creates a new project
    directory with a full Nuxt 4 + Pinia + @noy-db/nuxt starter.

Options:
  -y, --yes               Skip prompts; use defaults for missing values
      --adapter <name>    Adapter: browser (default) | file | memory
      --no-sample-data    (fresh mode) Skip the seed invoice records
      --dry-run           (augment mode) Show the diff without writing
      --force-fresh       Force fresh-project mode even when cwd looks
                          like an existing Nuxt project
      --lang <code>       UI language: en (default) | th
                          When omitted, auto-detected from LC_ALL/LANG
  -h, --help              Show this message and exit

Examples:
  # Fresh project in a new directory
  npm create @noy-db my-app
  npm create @noy-db my-app --yes --adapter file

  # Augment an existing Nuxt 4 project (run from its root)
  cd ~/my-existing-nuxt-app
  npm create @noy-db                          # preview the diff and confirm
  npm create @noy-db --dry-run                # print the diff, no write
  npm create @noy-db --yes                    # non-interactive, write immediately
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
    // Resolve the same locale the wizard will pick so the intro
    // banner matches the rest of the flow. Explicit --lang wins;
    // otherwise we fall back to env-var detection.
    const msg = loadMessages(parsed.options.locale ?? detectLocale())
    p.intro(pc.bgCyan(pc.black(' @noy-db/create ')))
    p.note(msg.wizardIntro)
  }

  try {
    await runWizard(parsed.options)
  } catch (err) {
    p.cancel((err as Error).message)
    process.exit(1)
  }
}

void main()
