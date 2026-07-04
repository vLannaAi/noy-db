#!/usr/bin/env node
/**
 * Bundle-size + cross-leak invariants for the v0.25 catalog.
 *
 * Synthesizes consumer scenarios, builds them with esbuild in
 * production mode, and asserts:
 *
 *   1. **Floor invariant** — `import { createNoydb } from '@noy-db/hub'`
 *      with no other imports compiles to ≤ FLOOR_LIMIT_BYTES (gzipped).
 *
 *   2. **Per-subsystem invariant** — importing exactly one
 *      `with<X>()` factory adds at most its allowance over the floor.
 *
 *   3. **Cross-leak invariant** — implementation classes from
 *      subsystems (LedgerStore, BlobSet, Aggregation, …) never appear
 *      verbatim in the floor scenario's output. If they do, a runtime
 *      import has snuck in and the catalog is silently broken.
 *
 * Run via:    pnpm --filter @noy-db/hub bundle-check
 * CI gate:    invoked from turbo's bundle-check task; exit 1 fails CI.
 *
 * Manifest:   ./bundle-manifest.json — checked-in baseline. Update via
 *             `BUNDLE_BASELINE_UPDATE=1 pnpm --filter @noy-db/hub bundle-check`
 *             when you intentionally accept a size shift.
 */

import { build } from 'esbuild'
import { gzipSync } from 'node:zlib'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const MANIFEST_PATH = join(__dirname, '..', 'bundle-manifest.json')

// Tolerance: real bundles wobble between builds by a few bytes due to
// hash-based chunk naming. Allow a 5% upward drift before failing.
const TOLERANCE_PCT = 5

/**
 * Each scenario is a tiny consumer program. The script writes it to a
 * temp dir, runs esbuild against it (resolving @noy-db/hub through
 * the repo's installed dist), and measures the gzipped output.
 *
 * `leakCanaries` are class names that MUST NOT appear verbatim in the
 * raw (un-minified, un-gzipped) bundle output. Their presence
 * indicates the floor scenario re-bundled subsystem implementation
 * code that should have been gated.
 */
const SCENARIOS = [
  {
    name: 'floor',
    description: 'createNoydb only — no subsystem opt-in',
    code: `
      import { createNoydb } from '@noy-db/hub'
      export { createNoydb }
    `,
    leakCanaries: [
      // Each canary names a class whose presence in the floor bundle
      // would mean its subsystem leaked through a runtime import.
      //
      // NOTE: with `splitting: true` (the post-#130 measurement mode)
      // class/const-literal definitions live in shared chunk files,
      // not in entry.js. These literal-pattern canaries therefore
      // catch a regression only if the bundling strategy ever loses
      // splitting and the definition gets inlined back into the entry.
      // The discriminating signal under code-splitting is `eagerImports`
      // (below) — the bare symbol appearing in the entry's top-level
      // `import { ... } from "./chunk-…"` prologue.
      'class LedgerStore',     // history (re-added post.)
      'class Aggregation',     // aggregate
      'class GroupedQuery',    // aggregate
      'class BlobSet',         // blobs
      'class DictionaryHandle',// i18n
      'class SyncEngine',      // sync
      'class PolicyEnforcer',  // session
      'class VaultInstant',    // history (time-machine)
      'class VaultFrame',      // shadow
      'class GuardRegistry',        // guards/registry.ts — must stay opt-in
      'class ReadOnlyVaultFacade',  // guards/read-only-facade.ts — must stay opt-in
      'class DerivationRegistry',   // derivations/registry.ts — must stay opt-in
      // Object-literal export shape (`const X = { ... }`). The trailing
      // `{` discriminates the actual static export from the lazy-loader
      // placeholder pattern `let GuardExecutor = null` that legitimately
      // lives in dynamic-import call sites.
      'GuardExecutor = {',          // guards/executor.ts (const object, not class) — must stay opt-in
      'DerivationExecutor = {',     // derivations/executor.ts (const object, not class) — must stay opt-in
    ],
    // Eager-import canaries — bare symbol names. The check scans the
    // entry chunk's top-level import prologue only; a hit means the
    // symbol arrived via a static `import { X } from "./chunk-…"`
    // statement rather than the intended `await import()` at the
    // call site. This is the load-bearing leak signal under
    // `splitting: true` — see #138 review (canaries didn't catch
    // residual statics because chunked definitions never appear in
    // entry.js).
    eagerImports: [
      'GuardRegistry',
      'ReadOnlyVaultFacade',
      'DerivationRegistry',
      'GuardExecutor',
      'DerivationExecutor',
    ],
  },
  {
    name: 'history',
    description: 'createNoydb + withHistory',
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withHistory } from '@noy-db/hub/history'
      export { createNoydb, withHistory }
    `,
    leakCanaries: [],
  },
  {
    name: 'classified',
    description: 'createNoydb + withClassified',
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withClassified } from '@noy-db/hub/classified'
      const classifiedStrategy = withClassified()
      export { createNoydb, classifiedStrategy }
    `,
    leakCanaries: [],
    eagerImports: [
      'revealSealedField', // reveal engine (enclave-side since stage 2)
      'verifyDigestField', // verify oracle — MUST stay behind active.ts's dynamic import
      'matchGroupFields',
      'mintVdigSlot',      // write-side digest engine (codec-internal, never eager via the strategy)
    ],
  },
  {
    name: 'analytics',
    description: 'createNoydb + withIndexing + withAggregate',
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withIndexing } from '@noy-db/hub/indexing'
      import { withAggregate } from '@noy-db/hub/aggregate'
      export { createNoydb, withIndexing, withAggregate }
    `,
    leakCanaries: [],
  },
  {
    name: 'all-on',
    description: 'every subsystem opted in (upper bound)',
    code: `
      import { createNoydb } from '@noy-db/hub'
      import { withHistory } from '@noy-db/hub/history'
      import { withI18n } from '@noy-db/hub/i18n'
      import { withSession } from '@noy-db/hub/session'
      import { withSync } from '@noy-db/hub/sync'
      import { withBlobs } from '@noy-db/hub/blobs'
      import { withIndexing } from '@noy-db/hub/indexing'
      import { withAggregate } from '@noy-db/hub/aggregate'
      import { withCrdt } from '@noy-db/hub/crdt'
      import { withConsent } from '@noy-db/hub/consent'
      import { withPeriods } from '@noy-db/hub/periods'
      import { withShadow } from '@noy-db/hub/shadow'
      import { withTransactions } from '@noy-db/hub/tx'
      export {
        createNoydb,
        withHistory, withI18n, withSession, withSync,
        withBlobs, withIndexing, withAggregate, withCrdt,
        withConsent, withPeriods, withShadow, withTransactions,
      }
    `,
    leakCanaries: [],
  },
]

async function buildScenario(scenario) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'noy-db-bundle-'))
  const entry = join(tmpDir, 'entry.mjs')
  const outdir = join(tmpDir, 'out')

  writeFileSync(entry, scenario.code)

  // Resolve @noy-db/hub through the workspace's hub dist directly.
  // We use --packages=external for everything else so the measurement
  // reflects only @noy-db/hub's contribution to the consumer bundle.
  //
  // `splitting: true` is REQUIRED for accurate measurement after #130
  // — the hub now uses dynamic `import()` to defer guard + derivation
  // class loading. Without splitting, esbuild inlines those imports
  // into the entry chunk and the floor measurement counts code that a
  // real consumer bundler (Vite, webpack, esbuild-with-splitting,
  // Rollup) would emit as a separate chunk loaded on demand. We
  // measure only the entry chunk's size; the split chunks live in
  // their own files and aren't charged against the floor.
  await build({
    entryPoints: [entry],
    outdir,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    treeShaking: true,
    splitting: true,
    nodePaths: [join(HUB_DIR, '..', '..', 'node_modules')],
    alias: {
      '@noy-db/hub': join(HUB_DIR, 'dist', 'index.js'),
      '@noy-db/hub/history': join(HUB_DIR, 'dist', 'history', 'index.js'),
      '@noy-db/hub/classified': join(HUB_DIR, 'dist', 'classified', 'index.js'),
      '@noy-db/hub/i18n': join(HUB_DIR, 'dist', 'i18n', 'index.js'),
      '@noy-db/hub/session': join(HUB_DIR, 'dist', 'session', 'index.js'),
      '@noy-db/hub/sync': join(HUB_DIR, 'dist', 'sync', 'index.js'),
      '@noy-db/hub/blobs': join(HUB_DIR, 'dist', 'blobs', 'index.js'),
      '@noy-db/hub/indexing': join(HUB_DIR, 'dist', 'indexing', 'index.js'),
      '@noy-db/hub/aggregate': join(HUB_DIR, 'dist', 'aggregate', 'index.js'),
      '@noy-db/hub/crdt': join(HUB_DIR, 'dist', 'crdt', 'index.js'),
      '@noy-db/hub/consent': join(HUB_DIR, 'dist', 'consent', 'index.js'),
      '@noy-db/hub/periods': join(HUB_DIR, 'dist', 'periods', 'index.js'),
      '@noy-db/hub/shadow': join(HUB_DIR, 'dist', 'shadow', 'index.js'),
      '@noy-db/hub/tx': join(HUB_DIR, 'dist', 'tx', 'index.js'),
    },
    logLevel: 'silent',
  })

  // Measure the entry chunk only — what a consumer's "open createNoydb"
  // route actually loads. Dynamic-import chunks are loaded on demand
  // when the consumer reaches code that registers a guard / derivation.
  const minified = readFileSync(join(outdir, 'entry.js'))
  const gzipped = gzipSync(minified)

  // Cross-leak detection runs against the un-gzipped, un-minified
  // ENTRY chunk only so canary class names survive AND we don't
  // false-positive on classes that legitimately live in a
  // dynamic-import chunk (the whole point of code splitting). A leak
  // is a class statically reachable from the entry — anything in a
  // split chunk is loaded on demand and not a cross-leak.
  const probeDir = join(tmpDir, 'probe')
  await build({
    entryPoints: [entry],
    outdir: probeDir,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: false,
    treeShaking: true,
    splitting: true,
    nodePaths: [join(HUB_DIR, '..', '..', 'node_modules')],
    alias: {
      '@noy-db/hub': join(HUB_DIR, 'dist', 'index.js'),
      '@noy-db/hub/history': join(HUB_DIR, 'dist', 'history', 'index.js'),
      '@noy-db/hub/classified': join(HUB_DIR, 'dist', 'classified', 'index.js'),
      '@noy-db/hub/i18n': join(HUB_DIR, 'dist', 'i18n', 'index.js'),
      '@noy-db/hub/session': join(HUB_DIR, 'dist', 'session', 'index.js'),
      '@noy-db/hub/sync': join(HUB_DIR, 'dist', 'sync', 'index.js'),
      '@noy-db/hub/blobs': join(HUB_DIR, 'dist', 'blobs', 'index.js'),
      '@noy-db/hub/indexing': join(HUB_DIR, 'dist', 'indexing', 'index.js'),
      '@noy-db/hub/aggregate': join(HUB_DIR, 'dist', 'aggregate', 'index.js'),
      '@noy-db/hub/crdt': join(HUB_DIR, 'dist', 'crdt', 'index.js'),
      '@noy-db/hub/consent': join(HUB_DIR, 'dist', 'consent', 'index.js'),
      '@noy-db/hub/periods': join(HUB_DIR, 'dist', 'periods', 'index.js'),
      '@noy-db/hub/shadow': join(HUB_DIR, 'dist', 'shadow', 'index.js'),
      '@noy-db/hub/tx': join(HUB_DIR, 'dist', 'tx', 'index.js'),
    },
    logLevel: 'silent',
  })
  const probe = readFileSync(join(probeDir, 'entry.js'), 'utf8')

  const leaks = scenario.leakCanaries.filter((canary) =>
    probe.includes(canary),
  )

  // Eager-import scan — extract the top-level `import { ... } from
  // "./chunk-…"` prologue and look for any banned symbol name. Under
  // `splitting: true` this is the only place a static-vs-dynamic
  // regression shows up in the entry chunk (the symbol's definition
  // lives in a separate chunk file and never enters entry.js, so the
  // literal-pattern canaries above can't see it).
  const eagerImports = scenario.eagerImports ?? []
  if (eagerImports.length > 0) {
    // The prologue is every top-level `import` statement (possibly
    // multi-line) at the head of the file. Esbuild always emits these
    // before any function/class/const declarations. We walk the file
    // line-by-line tracking brace depth inside an open `import {` block
    // so multi-line specifier lists count as part of the prologue.
    const lines = probe.split('\n')
    let prologueEnd = 0
    let inImportBlock = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (inImportBlock) {
        prologueEnd = i + 1
        if (line.includes('}')) inImportBlock = false
        continue
      }
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        prologueEnd = i + 1
        continue
      }
      if (trimmed.startsWith('import')) {
        prologueEnd = i + 1
        if (trimmed.includes('{') && !trimmed.includes('}')) inImportBlock = true
        continue
      }
      break
    }
    const prologue = lines.slice(0, prologueEnd).join('\n')
    for (const symbol of eagerImports) {
      // Match the symbol as a standalone identifier inside the
      // braces of an import specifier list (allowing trailing commas
      // and `as` aliases).
      const re = new RegExp(`^\\s*${symbol}(?:\\s*,|\\s+as\\s+\\w+|\\s*$)`, 'm')
      if (re.test(prologue)) leaks.push(`eager-import:${symbol}`)
    }
  }

  rmSync(tmpDir, { recursive: true, force: true })

  return {
    minifiedBytes: minified.length,
    gzippedBytes: gzipped.length,
    leaks,
  }
}

async function main() {
  const update = process.env.BUNDLE_BASELINE_UPDATE === '1'

  // Ensure the hub is built first.
  if (!existsSync(join(HUB_DIR, 'dist', 'index.js'))) {
    console.error('No dist/ found — run `pnpm --filter @noy-db/hub build` first.')
    process.exit(1)
  }

  const manifest = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { scenarios: {} }

  const results = {}
  let failures = 0

  console.log('\n📦 Bundle-size invariants — v0.25 catalog\n')
  console.log(
    `  ${'scenario'.padEnd(14)} ${'min'.padStart(8)} ${'gz'.padStart(8)}` +
    `   leaks    baseline (gz)   delta`,
  )
  console.log('  ' + '─'.repeat(74))

  for (const scenario of SCENARIOS) {
    const result = await buildScenario(scenario)
    results[scenario.name] = {
      minifiedBytes: result.minifiedBytes,
      gzippedBytes: result.gzippedBytes,
    }

    const baseline = manifest.scenarios?.[scenario.name]?.gzippedBytes
    let deltaPct = baseline
      ? ((result.gzippedBytes - baseline) / baseline) * 100
      : null
    let status = ''

    // Cross-leak check
    if (result.leaks.length > 0) {
      status = `❌ LEAKED: ${result.leaks.join(', ')}`
      failures++
    } else if (baseline && deltaPct > TOLERANCE_PCT) {
      status = `❌ +${deltaPct.toFixed(1)}% (over ${TOLERANCE_PCT}% tolerance)`
      failures++
    } else if (baseline && deltaPct !== null) {
      status = `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%`
    } else {
      status = '(no baseline yet)'
    }

    console.log(
      `  ${scenario.name.padEnd(14)} ` +
      `${result.minifiedBytes.toLocaleString().padStart(8)} ` +
      `${result.gzippedBytes.toLocaleString().padStart(8)}   ` +
      `${result.leaks.length === 0 ? '  ✓ ' : '  ✗ '} ` +
      `  ${baseline ? baseline.toLocaleString().padStart(10) : '       n/a'}   ${status}`,
    )
  }

  console.log()

  if (update) {
    if (failures === 0 || process.env.BUNDLE_BASELINE_FORCE === '1') {
      const newManifest = {
        ...manifest,
        scenarios: results,
        updatedAt: new Date().toISOString(),
      }
      writeFileSync(MANIFEST_PATH, JSON.stringify(newManifest, null, 2) + '\n')
      console.log(`✓ Manifest updated: ${MANIFEST_PATH}\n`)
      process.exit(0)
    } else {
      console.error(
        '✗ Refusing to update manifest while leak failures are present.\n' +
        '  Fix the leaks first, or set BUNDLE_BASELINE_FORCE=1 to override.\n',
      )
      process.exit(1)
    }
  }

  if (failures > 0) {
    console.error(
      `✗ ${failures} bundle-size invariant${failures === 1 ? '' : 's'} failed.\n` +
      '  Investigate the regressions above. If the change is intentional,\n' +
      '  run `BUNDLE_BASELINE_UPDATE=1 pnpm --filter @noy-db/hub bundle-check`\n' +
      '  to accept the new baseline.\n',
    )
    process.exit(1)
  }

  console.log('✓ All bundle-size invariants pass.\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
