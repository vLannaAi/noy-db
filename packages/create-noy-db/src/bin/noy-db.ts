#!/usr/bin/env node
/**
 * The `noy-db` bin. Invoked from inside an existing project by
 * `pnpm exec noy-db <command>`, `npx noy-db <command>`, etc.
 *
 * Subcommands (v0.5.0):
 *
 *   add <collection>                       Scaffold store + page files
 *   add user <id> <role> [--collections…]  Grant a new user access
 *   verify                                 In-memory integrity check
 *   rotate --vault … --user …        Rotate DEKs for a vault
 *   backup <target> --vault … …      Dump a vault to a file
 *   help                                   Show usage
 *
 * Future subcommands (deferred to a follow-up):
 *   seed                Re-run the project's seeder script (needs
 *                       a design decision on how seed scripts auth)
 *   backup s3://...     S3 targets (would bundle @aws-sdk; lives in
 *                       an optional companion package instead)
 *   restore <file>      Load a dumped backup into a vault
 *
 * ## Dispatcher design
 *
 * The dispatcher is intentionally dead simple: read argv[2], pick
 * a handler, pass the remaining args. No flag DSL, no auto-help
 * generation. Each subcommand's argv parser lives next to the
 * subcommand itself so the wiring is obvious and the pure
 * subcommand functions stay testable in isolation.
 *
 * ## Passphrase handling invariants
 *
 * Every subcommand that unlocks a vault goes through the
 * shared `defaultReadPassphrase` helper (see `commands/shared.ts`).
 * That helper:
 *
 *   - Uses @clack/prompts `password()` so nothing echoes to stdout
 *   - Never logs the returned value
 *   - Validates "not empty" up front; the real strength check
 *     happens inside the core's KEK derivation
 *   - Aborts the process on Ctrl-C before any I/O happens
 *
 * The passphrase never leaves the closure in which it was read —
 * every subcommand closes the Noydb instance in a `finally` block
 * so the KEK is cleared from memory on the way out.
 */

import pc from 'picocolors'
import { addCollection } from '../commands/add.js'
import { verifyIntegrity } from '../commands/verify.js'
import { rotate, type RotateOptions } from '../commands/rotate.js'
import { addUser, type AddUserOptions } from '../commands/add-user.js'
import { backup } from '../commands/backup.js'
import { assertRole, parseCollectionList } from '../commands/shared.js'

const HELP = `Usage: noy-db <command> [args]

Commands:
  add <collection>                             Scaffold a new collection store + page
  add user <userId> <role> [options]           Grant a new user access to a vault
  verify                                       In-memory crypto integrity check
  rotate [options]                             Rotate DEKs for a vault
  backup <target> [options]                    Dump a vault to a file
  help                                         Show this message

Common options for rotate / add user / backup:
  --dir <path>               Data directory (file adapter). Default: ./data
  --vault <name>       Vault (tenant) name. Required.
  --user <id>                Your user id in the vault. Required.
  --collections <list>       Comma-separated collection list. Format:
                               rotate:  invoices,clients
                               add user: invoices:rw,clients:ro (operator/client only)

Examples:
  noy-db add invoices
  noy-db add user accountant-ann operator --dir ./data --vault demo-co --user owner-alice --collections invoices:rw,clients:ro
  noy-db verify
  noy-db rotate --dir ./data --vault demo-co --user owner-alice
  noy-db backup ./backups/demo-co-2026-04-07.json --dir ./data --vault demo-co --user owner-alice

Run from the root of a project that already has a noy-db file
adapter directory in place. For new projects, use
\`npm create @noy-db\` instead.
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

    case 'rotate':
      await runRotate(rest)
      return

    case 'backup':
      await runBackup(rest)
      return

    default:
      process.stderr.write(`${pc.red('error:')} unknown command '${command}'\n\n${HELP}`)
      process.exit(2)
  }
}

// ─── `add` dispatcher — branches between `add <collection>` and `add user …` ─

async function runAdd(args: string[]): Promise<void> {
  const first = args[0]
  if (first === 'user') {
    await runAddUser(args.slice(1))
    return
  }
  // Legacy path: `noy-db add <collection>` scaffolds store + page files.
  if (!first) {
    process.stderr.write(
      `${pc.red('error:')} \`noy-db add\` requires either a collection name or the \`user\` subcommand\n\n` +
        `Examples:\n  noy-db add invoices\n  noy-db add user alice operator ...\n`,
    )
    process.exit(2)
  }
  try {
    const result = await addCollection({ name: first })
    process.stdout.write(`${pc.green('✔')} Created:\n`)
    for (const file of result.files) {
      process.stdout.write(`  ${pc.dim('→')} ${file}\n`)
    }
    process.stdout.write(
      `\nNext: visit ${pc.cyan(`/${first}`)} in your dev server, then edit ${pc.bold(`app/stores/${first}.ts`)} to match your domain.\n`,
    )
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(1)
  }
}

// ─── `verify` ──────────────────────────────────────────────────────────

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

// ─── `add user` ────────────────────────────────────────────────────────

async function runAddUser(args: string[]): Promise<void> {
  // Positional: userId, role. Then flag bag.
  const userId = args[0]
  const roleInput = args[1]
  if (!userId || !roleInput) {
    process.stderr.write(
      `${pc.red('error:')} \`noy-db add user\` requires <userId> <role>\n\n` +
        `Example: noy-db add user ann operator --dir ./data --vault demo-co --user owner-alice --collections invoices:rw\n`,
    )
    process.exit(2)
  }

  let role
  try {
    role = assertRole(roleInput)
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(2)
    return
  }

  const flags = parseFlags(args.slice(2))
  const dir = flags.dir ?? './data'
  const vault = requireFlag(flags, 'vault')
  const callerUser = requireFlag(flags, 'user')

  const permissions = parsePermissions(flags['collections'])

  const opts: AddUserOptions = {
    dir,
    vault,
    callerUser,
    newUserId: userId,
    role,
  }
  if (flags['display-name']) opts.newUserDisplayName = flags['display-name']
  if (permissions) opts.permissions = permissions

  try {
    const result = await addUser(opts)
    process.stdout.write(
      `${pc.green('✔')} Granted ${pc.bold(result.role)} access to ${pc.cyan(result.userId)} in vault ${pc.cyan(vault)}.\n`,
    )
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(1)
  }
}

// ─── `rotate` ──────────────────────────────────────────────────────────

async function runRotate(args: string[]): Promise<void> {
  const flags = parseFlags(args)
  const dir = flags.dir ?? './data'
  const vault = requireFlag(flags, 'vault')
  const user = requireFlag(flags, 'user')

  const opts: RotateOptions = { dir, vault, user }
  const collections = parseCollectionList(flags['collections'])
  if (collections) opts.collections = collections

  try {
    const result = await rotate(opts)
    process.stdout.write(
      `${pc.green('✔')} Rotated ${pc.bold(String(result.rotated.length))} collection(s) in ${pc.cyan(vault)}:\n`,
    )
    for (const name of result.rotated) {
      process.stdout.write(`  ${pc.dim('→')} ${name}\n`)
    }
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(1)
  }
}

// ─── `backup` ──────────────────────────────────────────────────────────

async function runBackup(args: string[]): Promise<void> {
  const target = args[0]
  if (!target) {
    process.stderr.write(
      `${pc.red('error:')} \`noy-db backup\` requires a target path\n\n` +
        `Example: noy-db backup ./backups/demo.json --dir ./data --vault demo-co --user owner-alice\n`,
    )
    process.exit(2)
  }

  const flags = parseFlags(args.slice(1))
  const dir = flags.dir ?? './data'
  const vault = requireFlag(flags, 'vault')
  const user = requireFlag(flags, 'user')

  try {
    const result = await backup({ dir, vault, user, target })
    process.stdout.write(
      `${pc.green('✔')} Wrote backup: ${pc.cyan(result.path)} ${pc.dim(`(${result.bytes} bytes)`)}\n`,
    )
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(1)
  }
}

// ─── Shared argv helpers ───────────────────────────────────────────────

/**
 * Parse a sequence of `--key value` flag pairs into a record.
 * Boolean flags (`--flag` with no value) become `"true"`. Unknown
 * shapes (positional args after the known set) are ignored — the
 * caller has already peeled positionals before passing in.
 */
function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg || !arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = 'true'
    }
  }
  return out
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name]
  if (!value) {
    process.stderr.write(
      `${pc.red('error:')} missing required flag --${name}\n`,
    )
    process.exit(2)
  }
  return value
}

/**
 * Parse `--collections invoices:rw,clients:ro` into a
 * `{ invoices: 'rw', clients: 'ro' }` record. Returns `null` when
 * the input is empty or undefined.
 */
function parsePermissions(
  input: string | undefined,
): Record<string, 'rw' | 'ro'> | null {
  if (!input) return null
  const out: Record<string, 'rw' | 'ro'> = {}
  for (const pair of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, mode] = pair.split(':')
    if (!name || !mode || (mode !== 'rw' && mode !== 'ro')) {
      throw new Error(
        `Invalid --collections entry "${pair}" — expected "name:rw" or "name:ro"`,
      )
    }
    out[name] = mode
  }
  return Object.keys(out).length > 0 ? out : null
}

main().catch((err: unknown) => {
  process.stderr.write(`${pc.red('fatal:')} ${(err as Error).message}\n`)
  process.exit(1)
})
