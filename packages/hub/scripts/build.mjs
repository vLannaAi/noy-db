#!/usr/bin/env node
// Hub build (#660).
//
// Two passes:
//   1. tsup — JS bundle only (`dts: false` in tsup.config.ts), all entries,
//      one invocation, `splitting: true` unchanged (runtime `instanceof`
//      identity across subpath boundaries — see tsup.config.ts).
//   2. plain `tsc --emitDeclarationOnly` (tsconfig.dts.json) — ONE program,
//      declaration output mirrors src/ 1:1 into dist/. Each type has
//      exactly one declaration site, cross-referenced by relative import;
//      package.json's exports map `types` conditions point at the
//      mirrored path per entry.
//
// This replaces tsup's `dts: true` (rollup-plugin-dts), which bundled each
// entry's declaration graph independently: peak RSS grew past 8GB across
// ~39 entries, AND any type reachable from more than one entry got a
// duplicate, independent declaration per entry — for a class with private
// fields (e.g. `LedgerStore`), TypeScript then treats the duplicates as
// nominally distinct types across those subpaths. Measured tradeoff:
// plain tsc is both far cheaper AND correct (see
// .superpowers/sdd/m26-task-2-report.md for the numbers).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { ENTRIES } from '../tsup.entries.mjs'

const TSUP_CLI = '../../node_modules/tsup/dist/cli-default.js'
const TSC_CLI = '../../node_modules/typescript/bin/tsc'

// Env-overridable for local experimentation. Defaults chosen from the #660
// measurement: the tsc declaration pass peaked at ~430MB, so 2048MB is
// ~4.7x headroom (child --max-old-space-size) and 1536MB is ~3.5x headroom
// (the guard budget that fails the build) — both a small fraction of the
// old 12288MB this replaces.
const DTS_MAX_OLD_SPACE_MB = Number(process.env.HUB_DTS_MAX_OLD_SPACE_MB) || 2048
const DTS_RSS_BUDGET_MB = Number(process.env.HUB_DTS_RSS_BUDGET_MB) || 1536

// Portable peak-RSS measurement: macOS's `/usr/bin/time -l` reports
// "maximum resident set size" in BYTES; Linux's GNU `/usr/bin/time -v`
// reports "Maximum resident set size (kbytes)" in KB (CI is ubuntu). If
// the `time` binary isn't present at all, fall back to running the command
// unmeasured rather than failing the build over missing tooling — the
// budget check is a guard, not a hard dependency.
function measuredSpawn(cmd, args) {
  const isDarwin = process.platform === 'darwin'
  const timeFlag = isDarwin ? '-l' : '-v'
  if (!existsSync('/usr/bin/time')) {
    console.warn('[build] /usr/bin/time not found — running unmeasured, no RSS guard for this step')
    const res = spawnSync(cmd, args, { stdio: 'inherit' })
    return { status: res.status, peakRssBytes: null }
  }

  const res = spawnSync('/usr/bin/time', [timeFlag, cmd, ...args], {
    encoding: 'utf8',
    stdio: ['inherit', 'inherit', 'pipe'],
  })
  const report = res.stderr || ''
  process.stderr.write(report)

  let peakRssBytes = null
  if (isDarwin) {
    const m = report.match(/(\d+)\s+maximum resident set size/)
    if (m) peakRssBytes = Number(m[1])
  } else {
    const m = report.match(/Maximum resident set size \(kbytes\):\s*(\d+)/i)
    if (m) peakRssBytes = Number(m[1]) * 1024
  }
  return { status: res.status, peakRssBytes }
}

function fail(message) {
  console.error(`\n[build] FAILED — ${message}\n`)
  process.exit(1)
}

console.log('[build] pass 1/2: JS bundle (tsup, all entries, dts disabled)')
{
  const res = spawnSync('node', [TSUP_CLI], { stdio: 'inherit' })
  if (res.status !== 0) fail('JS build failed')
}

console.log('[build] pass 2/2: declarations (tsc --emitDeclarationOnly, one program)')
{
  const budgetBytes = DTS_RSS_BUDGET_MB * 1024 * 1024
  const { status, peakRssBytes } = measuredSpawn('node', [
    `--max-old-space-size=${DTS_MAX_OLD_SPACE_MB}`,
    TSC_CLI,
    '-p',
    'tsconfig.dts.json',
  ])
  if (status !== 0) fail('tsc declaration build failed — see output above')

  if (peakRssBytes !== null) {
    const peakMB = Math.round(peakRssBytes / 1024 / 1024)
    console.log(`[build]   tsc dts peak RSS: ${peakMB} MB`)
    if (peakRssBytes > budgetBytes) {
      fail(
        [
          `tsc declaration build peak RSS ${peakMB} MB exceeded the ${DTS_RSS_BUDGET_MB} MB budget.`,
          'This means the type surface grew significantly. Options: (a) simplify the type',
          'surface that grew, or (b) if the growth is intentional, raise',
          'HUB_DTS_RSS_BUDGET_MB / HUB_DTS_MAX_OLD_SPACE_MB deliberately (and the workflow',
          'NODE_OPTIONS caps in .github/workflows/*.yml) — do not raise them silently.',
        ].join('\n'),
      )
    }
  } else {
    console.log('[build]   (peak RSS unmeasured — /usr/bin/time unavailable)')
  }
}

// Sanity check: every entry's mirrored declaration file must exist —
// catches a src/ move that package.json's exports map wasn't updated for.
{
  const missing = []
  for (const srcPath of Object.values(ENTRIES)) {
    const mirrored = srcPath.replace(/^src\//, '').replace(/\.ts$/, '.d.ts')
    if (!existsSync(`dist/${mirrored}`)) missing.push(mirrored)
  }
  if (missing.length > 0) {
    fail(`missing mirrored declaration file(s) for entries: ${missing.join(', ')} — check package.json's exports map "types" targets and tsup.entries.mjs are in sync`)
  }
}

// Sanity check: package.json's "exports" map is the CONSUMER-FACING contract
// (not tsup.entries.mjs, which is internal) — every subpath's "types" and
// "default" target must exist in dist/, or a stale/typo'd exports entry
// would ship broken consumer types with nothing to catch it.
{
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const missing = []
  for (const [subpath, condition] of Object.entries(pkg.exports)) {
    if (typeof condition === 'string') {
      if (!existsSync(condition.replace(/^\.\//, ''))) missing.push(`${subpath} -> ${condition}`)
      continue
    }
    for (const key of ['types', 'import', 'default']) {
      const target = condition[key]
      if (typeof target === 'string' && !existsSync(target.replace(/^\.\//, ''))) {
        missing.push(`${subpath} [${key}] -> ${target}`)
      }
    }
  }
  if (missing.length > 0) {
    fail(
      [
        `package.json "exports" map has ${missing.length} target(s) missing from dist/:`,
        ...missing.map((m) => `  - ${m}`),
        'This means a subpath\'s exports entry is stale or typo\'d relative to src/ — fix the',
        'exports map (or the src move that orphaned it) so every published subpath resolves.',
      ].join('\n'),
    )
  }
}

console.log('[build] done.')
