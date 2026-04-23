#!/usr/bin/env node
/**
 * `noydb` — command dispatcher.
 *
 * Routes argv to the appropriate subcommand. Kept minimal by design
 * (no commander/yargs dep) — v0.13 scope is small enough for flat
 * if/else routing. Revisit if/when the CLI grows past ~5 commands.
 *
 *   noydb inspect <file.noydb>
 *   noydb verify  <file.noydb>
 *   noydb config validate <file.ts>
 *   noydb config scaffold [--profile=<A-J>]
 *   noydb monitor <config.ts> [--interval=ms]
 *   noydb --help
 *   noydb --version
 *
 * @module
 */
import { runInspect } from '../commands/inspect.js'
import { runVerify } from '../commands/verify.js'
import { runConfigValidate, runConfigScaffold } from '../commands/config.js'
import { runMonitor } from '../commands/monitor.js'

const VERSION = '0.1.0'

function usage(): string {
  return [
    'noydb — command-line tools for @noy-db',
    '',
    'Usage:',
    '  noydb inspect <file.noydb>                 Print bundle header (no passphrase)',
    '  noydb verify  <file.noydb>                 Verify bundle integrity (no passphrase)',
    '  noydb config validate <file.js|mjs>        Sanity-check a NoydbOptions file',
    '  noydb config scaffold [--profile=<A-J>]    Emit a topology-profile skeleton',
    '  noydb monitor <file.js|mjs> [--interval=ms] Live dashboard of store metrics',
    '',
    'TypeScript configs: run under a TS-capable runtime, e.g. `npx tsx $(which noydb) config validate foo.ts`.',
    '  noydb --version                            Print CLI version',
    '  noydb --help                               Show this message',
    '',
    'Profiles for `config scaffold` map to docs/topology-matrix.md § View 3.',
  ].join('\n')
}

async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(usage() + '\n')
    return 0
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(VERSION + '\n')
    return 0
  }

  switch (cmd) {
    case 'inspect': return runInspect(rest)
    case 'verify':  return runVerify(rest)
    case 'monitor': return runMonitor(rest)
    case 'config': {
      const [sub, ...subRest] = rest
      if (sub === 'validate') return runConfigValidate(subRest)
      if (sub === 'scaffold') return runConfigScaffold(subRest)
      process.stderr.write(`unknown config subcommand: ${sub ?? '(none)'}\n`)
      return 2
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${usage()}\n`)
      return 2
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${(err as Error).message}\n`)
    process.exit(1)
  })
