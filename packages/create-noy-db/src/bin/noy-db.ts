#!/usr/bin/env node
/**
 * The `noy-db` bin. Invoked from inside an existing project by
 * `pnpm exec noy-db <command>`, `npx noy-db <command>`, etc.
 *
 * Subcommands (v0.3.1):
 *   add <collection>   Scaffold app/stores/<name>.ts + app/pages/<name>.vue
 *   verify             Run the in-memory crypto round-trip integrity check
 *   help               Print usage and exit 0
 *
 * Future subcommands (v0.4+, deferred):
 *   rotate             Interactive key rotation
 *   seed               Re-run the seeder
 *   backup <uri>       One-shot encrypted backup
 *
 * The dispatcher is dead simple: read argv[2], pick a handler, pass the
 * remaining args. No flag DSL, no auto-help generation. The whole point
 * of this bin is to be small and predictable.
 */

import pc from 'picocolors'
import { addCollection } from '../commands/add.js'
import { verifyIntegrity } from '../commands/verify.js'

const HELP = `Usage: noy-db <command> [args]

Commands:
  add <collection>     Scaffold a new collection store + page in the current project
  verify               Run an end-to-end crypto integrity check (in-memory)
  help                 Show this message

Examples:
  noy-db add invoices
  noy-db verify

Run from the root of a Nuxt 4 project that already has @noy-db/nuxt installed.
For new projects, use \`npm create noy-db@latest\` instead.
`

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv

  switch (command) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(HELP)
      return

    case 'add':
      await runAdd(rest)
      return

    case 'verify':
      await runVerify()
      return

    default:
      process.stderr.write(`${pc.red('error:')} unknown command '${command}'\n\n${HELP}`)
      process.exit(2)
  }
}

async function runAdd(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    process.stderr.write(`${pc.red('error:')} \`noy-db add\` requires a collection name\n\nExample: noy-db add invoices\n`)
    process.exit(2)
  }
  try {
    const result = await addCollection({ name })
    process.stdout.write(`${pc.green('✔')} Created:\n`)
    for (const file of result.files) {
      process.stdout.write(`  ${pc.dim('→')} ${file}\n`)
    }
    process.stdout.write(
      `\nNext: visit ${pc.cyan(`/${name}`)} in your dev server, then edit ${pc.bold(`app/stores/${name}.ts`)} to match your domain.\n`,
    )
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(1)
  }
}

async function runVerify(): Promise<void> {
  process.stdout.write(`${pc.dim('▸ Running noy-db integrity check…')}\n`)
  const result = await verifyIntegrity()
  if (result.ok) {
    process.stdout.write(`${pc.green('✔')} ${result.message} ${pc.dim(`(${result.durationMs}ms)`)}\n`)
    return
  }
  process.stderr.write(`${pc.red('✘')} ${result.message} ${pc.dim(`(${result.durationMs}ms)`)}\n`)
  process.exit(1)
}

main().catch((err: unknown) => {
  process.stderr.write(`${pc.red('fatal:')} ${(err as Error).message}\n`)
  process.exit(1)
})
