#!/usr/bin/env node
/**
 * scripts/release.mjs — version-normalizer for pnpm changeset version
 *
 * Run via: pnpm release:version
 *
 * What it does:
 *   1. Runs `pnpm changeset version` to compute per-package version bumps
 *      and write CHANGELOG.md sections.
 *   2. Reads the version that @noy-db/core landed on (the canonical version).
 *   3. Walks every packages/* directory and normalizes its package.json
 *      `version` field to match @noy-db/core, overriding whatever the
 *      changeset heuristic computed.
 *   4. Prints a summary of the normalized versions.
 *
 * Why this is needed:
 *   The changeset CLI pre-1.0 heuristic major-bumps dependents when a peer
 *   dep changes, even with loose "workspace:*" constraints. For NOYDB — which
 *   ships all packages in lockstep on a single minor version line — this causes
 *   adapter packages to jump from 0.x.0 to 1.0.0 on every core minor bump.
 *   v1.0 is reserved for the LTS release per ROADMAP. Full diagnosis in
 *   docs/v0.6/retrospective.md §"Surprise #2".
 *
 * Safety checks:
 *   - Aborts (exit 1) if any package ends up with a version > core's version,
 *     or if any package ends up on a version that would be a major bump from
 *     the previous release line (e.g., 0.x → 1.0 when core is 0.y).
 *   - Logs every package that was corrected so the engineer can verify.
 *   - Does NOT touch workspace:* inter-package dependency entries — those are
 *     rewritten to real versions by `pnpm changeset publish` at publish time.
 *
 * `--resume`:
 *   Finishes a run that aborted BETWEEN step 1 and step 3. That gap is not
 *   recoverable by re-running: `changeset version` has already consumed and
 *   DELETED every changeset file, and `.changeset/` is gitignored here, so
 *   there is nothing for git to restore and a second run would see an empty
 *   queue and correctly refuse as a no-op. The release itself is not lost —
 *   each changeset's prose is already written into the tracked CHANGELOGs.
 *
 *   Resume therefore skips step 1 and takes its baseline from `git HEAD`,
 *   which still holds the pre-run versions because the run's edits are
 *   uncommitted. The baseline is READ, never supplied by hand: a
 *   mistyped baseline would silently mis-normalize the whole line.
 *
 *   Only for an aborted run. On a clean tree it finds baseline == current and
 *   the advance guard refuses it, which is the correct answer.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCanonicalAdvanced, nextLineVersion, changesetWroteASection } from './release/version-advanced.mjs'

const __dir = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dir, '..')

const RESUME = process.argv.includes('--resume')

/**
 * A package's version as COMMITTED, i.e. before this run touched anything.
 * Returns undefined for a package that does not exist at HEAD (newly added).
 */
function committedVersion(dirName) {
  try {
    const raw = execSync(`git show HEAD:packages/${dirName}/package.json`, { cwd: ROOT, encoding: 'utf8' })
    const parsed = JSON.parse(raw)
    return parsed.version
  } catch {
    return undefined
  }
}

// ─── 0. Capture the canonical version BEFORE anything mutates it (#1230) ──
//
// This has to be read here, not later: the guard below compares against it to
// refuse a run that consumes changesets without advancing the release line.

const corePkgPathPre = join(resolve(fileURLToPath(new URL('.', import.meta.url)), '..'), 'packages', 'hub', 'package.json')
const canonicalVersionBefore = RESUME
  ? committedVersion('hub')
  : JSON.parse(readFileSync(corePkgPathPre, 'utf8')).version

// And every package's version, for the same reason at a finer grain: the
// CHANGELOG heading rewrite below is only sound for packages `changeset
// version` actually moved (#1230). For one it left alone, the topmost heading
// is the PREVIOUSLY PUBLISHED section and rewriting it renames released history.
const versionsBefore = {}
{
  const dir0 = join(resolve(fileURLToPath(new URL('.', import.meta.url)), '..'), 'packages')
  for (const name of readdirSync(dir0)) {
    if (RESUME) { versionsBefore[name] = committedVersion(name); continue }
    try { versionsBefore[name] = JSON.parse(readFileSync(join(dir0, name, 'package.json'), 'utf8')).version }
    catch { /* not a package dir */ }
  }
}

// ─── 1. Run changeset version ──────────────────────────────────────────

if (RESUME) {
  console.log(
    `\n[release] --resume: skipping \`changeset version\` (already run and its changesets consumed).` +
    `\n[release] Baseline read from git HEAD: hub was ${canonicalVersionBefore}.\n`,
  )
} else {
console.log('\n[release] Running pnpm changeset version...\n')
try {
  execSync('pnpm changeset version', { cwd: ROOT, stdio: 'inherit' })
} catch (err) {
  console.error('\n[release] pnpm changeset version failed — aborting.')
  process.exit(1)
}
}

// ─── 2. Read canonical version from @noy-db/hub ───────────────────────

const corePkgPath = join(ROOT, 'packages', 'hub', 'package.json')
const corePkg = JSON.parse(readFileSync(corePkgPath, 'utf8'))
let canonicalVersion = corePkg.version

if (!canonicalVersion || !/^\d+\.\d+\.\d+/.test(canonicalVersion)) {
  console.error(`[release] Could not read a valid version from ${corePkgPath}. Got: ${canonicalVersion}`)
  process.exit(1)
}

// #1230 — a release is a LINE MOVE, so the canonical version must advance even
// when no changeset targeted hub (a satellite-only release). Without this the
// normalizer drags the legitimately-bumped satellite back down to hub's
// unchanged, already-published version and the run publishes nothing.
if (canonicalVersion === canonicalVersionBefore) {
  const advanced = nextLineVersion(canonicalVersionBefore)
  console.log(
    `\n[release] No changeset targeted @noy-db/hub, so the canonical version did not move.\n` +
    `[release] A release is a lockstep LINE MOVE — advancing the whole line ${canonicalVersionBefore} -> ${advanced} (#1230).\n`,
  )
  canonicalVersion = advanced
}

// The backstop, asserted on the OUTCOME rather than the cause: whatever path
// got us here, the line must have advanced. Fails loudly if it did not.
try {
  assertCanonicalAdvanced(canonicalVersionBefore, canonicalVersion)
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}

console.log(`\n[release] Canonical version from @noy-db/hub: ${canonicalVersion}\n`)

// ─── 3. Walk packages/* and normalize versions ─────────────────────────

const packagesDir = join(ROOT, 'packages')
const packageDirs = readdirSync(packagesDir).filter((name) => {
  const full = join(packagesDir, name)
  // `test-adapter-conformance` was excluded here while it was an internal
  // harness. It became a published package on the lockstep line at
  // 0.6.0-pre.1, and the exclusion outlived that: `changeset version`'s
  // pre-1.0 heuristic bumped it 0.6.0-pre.2 → 1.0.0-pre.3 and nothing pulled
  // it back, which would have shipped a 1.0.0 on a 0.6.x line (v1.0 is
  // reserved for LTS). It normalizes with everything else now.
  return statSync(full).isDirectory() && name !== 'typescript-config'
})

const corrected = []
const alreadyCorrect = []

for (const dir of packageDirs) {
  const pkgPath = join(packagesDir, dir, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    // No package.json (e.g. internal tooling dirs) — skip
    continue
  }

  if (!pkg.name || !pkg.name.startsWith('@noy-db/')) {
    continue
  }

  if (pkg.version === canonicalVersion) {
    alreadyCorrect.push(pkg.name)
    continue
  }

  const before = pkg.version
  pkg.version = canonicalVersion
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  corrected.push({ name: pkg.name, dir, before, after: canonicalVersion })
}

// ─── 3b. Normalize the CHANGELOG headings changeset already wrote ──────
//
// `changeset version` writes the CHANGELOG section title from the version its
// heuristic computed, which step 3 has just overridden in package.json. Without
// this pass every corrected package ships a `## 1.0.0-pre.N` heading naming a
// version that was never published (#827). `corrected` is exactly the
// before → after map needed; rewrite only the exact heading line.

const headingsFixed = []

for (const { dir, before, after } of corrected) {
  // #1230 — only rewrite a heading changeset version just wrote. Skipping here
  // means a version-only lockstep bump ships with no new CHANGELOG entry, which
  // is the honest outcome: nothing about that package changed.
  if (!changesetWroteASection(versionsBefore[dir], before)) continue
  const changelogPath = join(packagesDir, dir, 'CHANGELOG.md')
  let text
  try {
    text = readFileSync(changelogPath, 'utf8')
  } catch {
    // Package has no CHANGELOG (nothing released from it yet) — skip
    continue
  }

  const lines = text.split('\n')
  const fixed = lines.map((line) => (line === `## ${before}` ? `## ${after}` : line))
  if (fixed.some((line, i) => line !== lines[i])) {
    writeFileSync(changelogPath, fixed.join('\n'), 'utf8')
    headingsFixed.push(dir)
  }
}

// ─── 4. Report ─────────────────────────────────────────────────────────

if (corrected.length > 0) {
  console.log('[release] Normalized versions (corrected from changeset heuristic):')
  for (const { name, before, after } of corrected) {
    console.log(`  ${name.padEnd(32)} ${before.padEnd(12)} → ${after}`)
  }
} else {
  console.log('[release] No version corrections needed — all packages already match core.')
}

if (headingsFixed.length > 0) {
  console.log(`\n[release] Rewrote the CHANGELOG heading to ${canonicalVersion} in ${headingsFixed.length} package(s).`)
}

if (alreadyCorrect.length > 0) {
  console.log(`\n[release] Already at ${canonicalVersion}: ${alreadyCorrect.join(', ')}`)
}

// ─── 5. Sanity-check: no package has a version higher than core ────────

const [coreMajor, coreMinor, corePatch] = canonicalVersion.split('.').map(Number)
let failed = false

for (const dir of packageDirs) {
  const pkgPath = join(packagesDir, dir, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    continue
  }
  if (!pkg.name || !pkg.name.startsWith('@noy-db/')) continue

  const [maj, min, pat] = (pkg.version ?? '').split('.').map(Number)
  if (maj > coreMajor || (maj === coreMajor && min > coreMinor) || (maj === coreMajor && min === coreMinor && pat > corePatch)) {
    console.error(`\n[release] ERROR: ${pkg.name}@${pkg.version} is HIGHER than core@${canonicalVersion}. This should never happen.`)
    failed = true
  }
  // Guard the v1.0 reserved boundary: abort if any package is at 1.x when core is 0.x
  if (coreMajor === 0 && maj >= 1) {
    console.error(`\n[release] ERROR: ${pkg.name}@${pkg.version} is at major >= 1 but core is at 0.x. v1.0 is reserved for the LTS release per ROADMAP.`)
    failed = true
  }
}

if (failed) {
  console.error('\n[release] Aborting due to version sanity check failures above. DO NOT commit.')
  process.exit(1)
}

// ─── 6. Done ───────────────────────────────────────────────────────────

console.log(`
[release] Done. All @noy-db/* packages are now at ${canonicalVersion}.

Next steps:
  git diff packages/*/package.json          # verify the normalization
  git diff packages/*/CHANGELOG.md          # inspect the generated changelogs
  grep -r '1\\.0\\.0' packages/*/package.json  # sanity-check no stray 1.0.0
  git add . && git commit -m "chore: release v${canonicalVersion}"
  git push origin main
  # wait for CI
  git tag -a v${canonicalVersion} -m "v${canonicalVersion}"
  git push origin v${canonicalVersion}
  pnpm changeset publish
`)
