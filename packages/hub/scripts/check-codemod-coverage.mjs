/**
 * Codemod-map COVERAGE — the output-domain half of the rename contract.
 *
 * `codemod-map-0.6.test.ts` validates the rows that are PRESENT: every `to`
 * exists, every `from` is genuinely gone. By construction it cannot see a
 * rename that is MISSING — which is #1061 (`hasNoydbBundleMagic`) moved out of
 * the prose table and into the artefact that replaced the prose table. #1154
 * reported the same shape again: `LiveAggregation` renamed with its siblings
 * mapped and itself absent.
 *
 * A wider table of rows cannot find that class. Only an assertion about the
 * OUTPUT domain can:
 *
 *   every symbol a PUBLISHED surface once exposed, and the current surface no
 *   longer exposes, must appear as a `from` in some shipped codemod map.
 *
 * Two properties make it trustworthy rather than noisy:
 *
 *  - REACHABILITY, not `grep dist`. A symbol counts only if a consumer can
 *    name it through a declared `exports` subpath, following `export *` chains.
 *    Computed by the TypeScript checker via `lib/surface.mjs` — shared with
 *    check-type-reachability.mjs so the two guards cannot disagree about what
 *    the surface IS. A raw scan of `dist` reports 1707 symbols for published
 *    0.3.0 where 1143 are reachable; the surplus is module-internal names no
 *    consumer could hold — the over-count that made #1052's prose table wrong
 *    about `SubsystemBus`.
 *  - A BASELINE, not "the previous version". The check is hermetic: it compares
 *    the live surface against a committed snapshot of the last published
 *    stable, so it needs no network and cannot drift with the registry.
 *
 * Verified against real tarballs before it was written (the transitions the
 * shipped maps cover):
 *
 *     0.3.0 → 0.4.0    lost 93   unmapped 79   (the 0.4 restructure)
 *     0.4.0 → 0.5.0    lost  0   unmapped  0   ← the negative control
 *     0.5.0 → 0.6.0    lost 23   unmapped  2   ← both real: encodeBundleHeader,
 *                                                validateBundleHeader
 *
 * The clean middle row is the point. A checker that always finds something is
 * a checker nobody reads.
 *
 * ⚠️ A loss is not automatically a rename. Three classes come out of this and
 * they want different rows: RENAMED (`to` set), REMOVED (`kind: 'removed'`,
 * `to: null`), and DE-EXPORTED — still present internally, no longer public,
 * which is a consumer break with no successor. Judgement is still required;
 * what this removes is the possibility of never being asked.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reachableExports } from './lib/surface.mjs'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(PKG, 'scripts/published-surface-0.6.0.json')

/** Every `from` across every shipped codemod map. */
export function mappedFroms(codemodDir, io = {}) {
  const read = io.read ?? ((f) => readFileSync(f, 'utf8'))
  const list = io.readDir ?? readdirSync
  const froms = new Set()
  for (const f of list(codemodDir)) {
    if (!f.endsWith('.json')) continue
    const map = JSON.parse(read(join(codemodDir, f)))
    for (const row of map.renames ?? []) froms.add(row.from)
  }
  return froms
}

/**
 * THE ASSERTION. Pure, so it is testable without a build:
 * baseline − current − mapped must be empty.
 */
export function uncoveredLosses(baseline, current, mapped) {
  return [...baseline].filter((s) => !current.has(s) && !mapped.has(s)).sort()
}

// ─── runner ────────────────────────────────────────────────────────────
// Split behind an isMain check so importing this module for tests builds
// nothing and reads nothing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(join(PKG, 'dist'))) {
    console.error('✗ packages/hub/dist missing — run `pnpm build` first (this check reads the BUILT surface, because what a consumer can import is a fact about dist, not src)')
    process.exit(1)
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const current = reachableExports(PKG).all
  const mapped = mappedFroms(join(PKG, 'codemods'))
  const uncovered = uncoveredLosses(new Set(baseline.exports), current, mapped)

  if (uncovered.length > 0) {
    console.error(`✗ ${uncovered.length} symbol(s) left the published surface since ${baseline.version} with no codemod row:\n`)
    for (const s of uncovered) console.error(`    ${s}`)
    console.error('\n  Add a row to packages/hub/codemods/<line>.json — `to` for a rename,')
    console.error('  `kind: "removed"` + `to: null` for a deletion. A consumer holding one of')
    console.error('  these has no mechanical way to find its replacement.')
    process.exit(1)
  }
  console.log(`✅ codemod coverage: ${baseline.exports.length} baseline symbols (${baseline.version}), 0 uncovered losses`)
}
