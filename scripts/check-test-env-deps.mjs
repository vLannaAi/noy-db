#!/usr/bin/env node
/**
 * declare-what-your-tests-run-in (#1228 follow-up).
 *
 * A package that selects a test ENVIRONMENT must declare the package providing
 * it. `happy-dom` is the live case: 21 packages selected it and 4 declared it,
 * at three different majors, so those suites ran against whichever version won
 * hoisting — pinned by nothing.
 *
 * ⚠️ WHY THIS SCRIPT EXISTS AND A MANIFEST SWEEP DOES NOT SUFFICE. Declaring
 * the dependency does NOT make the mistake self-detecting: pnpm's virtual store
 * still satisfies an UNDECLARED package from a sibling that declares it, so
 * deleting a declaration leaves every test passing. Measured, not assumed —
 * deleting one and reinstalling ran the suite green. So the manifests being
 * correct today prevents nothing tomorrow; only a static check does.
 *
 * ⚠️ AND ASK THE TOOL THAT RUNS THE CODE. `require.resolve` reports the
 * opposite answer here, because Node's resolution algorithm is not pnpm's
 * virtual store. This check reads MANIFESTS against USAGE and never resolves.
 *
 * Usage is detected two ways, because one of them is invisible to both an
 * import scan and a config grep:
 *   1. `environment: 'x'` / `environmentMatchGlobs` in vitest.config.ts
 *   2. an `@vitest-environment x` DOCBLOCK PRAGMA in a test file — how `hub`
 *      uses happy-dom, and why every earlier count missed it
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ENVIRONMENTS = { 'happy-dom': 'happy-dom', jsdom: 'jsdom', 'edge-runtime': '@edge-runtime/vm' }
const PKGS = join(process.cwd(), 'packages')

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

const violations = []
for (const pkg of readdirSync(PKGS)) {
  const manifestPath = join(PKGS, pkg, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = new Set([
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.dependencies ?? {}),
  ])

  const used = new Map()
  const cfg = join(PKGS, pkg, 'vitest.config.ts')
  if (existsSync(cfg)) {
    const text = readFileSync(cfg, 'utf8')
    for (const [env, dep] of Object.entries(ENVIRONMENTS)) {
      if (new RegExp(`environment[^\\n]*['"]${env}['"]`).test(text)
        || new RegExp(`environmentMatchGlobs[\\s\\S]{0,600}${env}`).test(text)) used.set(dep, `vitest.config.ts (${env})`)
    }
  }
  for (const file of walk(join(PKGS, pkg, '__tests__'))) {
    const text = readFileSync(file, 'utf8')
    for (const [env, dep] of Object.entries(ENVIRONMENTS)) {
      // The pragma form. A comment merely NAMING the environment is not a use —
      // by-peer mentions happy-dom in prose while running on node, and counting
      // that produced a devDependency for something it never runs.
      if (new RegExp(`@vitest-environment\\s+${env}\\b`).test(text)) {
        used.set(dep, `${file.replace(PKGS + '/', '')} (@vitest-environment)`)
      }
    }
  }

  for (const [dep, where] of used) {
    if (!declared.has(dep)) violations.push(`${pkg}: runs tests in "${dep}" (${where}) but does not declare it`)
  }
  // The OTHER direction, added after it caught a real mistake of mine: a
  // package declaring an environment it never runs in. `by-peer` acquired one
  // because a substring scan counted a MENTION in a comment, and
  // `to-browser-idb` carried one that predated all of this while running on
  // `node` with a fake-indexeddb polyfill.
  //
  // Worth catching rather than tolerating, even though a phantom devDependency
  // is individually cheap: a package that DECLARES an environment it does not
  // use is what silently satisfies the packages that use it and do not declare
  // it. That is the mechanism this whole class rests on — the over-declaration
  // is what makes the under-declaration invisible.
  for (const dep of Object.values(ENVIRONMENTS)) {
    if (declared.has(dep) && !used.has(dep)) {
      violations.push(`${pkg}: declares "${dep}" but runs no tests in it — remove it, or it will keep satisfying packages that fail to declare it`)
    }
  }
}

if (violations.length > 0) {
  console.error(`\n✗ test-env-deps: ${violations.length} package(s) use a test environment they do not declare\n`)
  for (const v of violations) console.error(`  ${v}`)
  console.error('\n  Both directions matter, and they are the same mechanism seen from two ends:'
    + '\n  a sibling declaring it is enough for the install to succeed, so an UNDECLARED'
    + '\n  use passes locally and in CI until that sibling moves or changes major — and an'
    + '\n  OVER-declaration is what supplies that satisfaction in the first place.\n')
  process.exit(1)
}
console.log(`✓ test-env-deps: every package declares the test environment it runs in`)
