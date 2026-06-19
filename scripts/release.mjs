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
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(__dir, '..')

// ─── 1. Run changeset version ──────────────────────────────────────────

console.log('\n[release] Running pnpm changeset version...\n')
try {
  execSync('pnpm changeset version', { cwd: ROOT, stdio: 'inherit' })
} catch (err) {
  console.error('\n[release] pnpm changeset version failed — aborting.')
  process.exit(1)
}

// ─── 2. Read canonical version from @noy-db/hub ───────────────────────

const corePkgPath = join(ROOT, 'packages', 'hub', 'package.json')
const corePkg = JSON.parse(readFileSync(corePkgPath, 'utf8'))
const canonicalVersion = corePkg.version

if (!canonicalVersion || !/^\d+\.\d+\.\d+/.test(canonicalVersion)) {
  console.error(`[release] Could not read a valid version from ${corePkgPath}. Got: ${canonicalVersion}`)
  process.exit(1)
}

console.log(`\n[release] Canonical version from @noy-db/hub: ${canonicalVersion}\n`)

// ─── 3. Walk packages/* and normalize versions ─────────────────────────

const packagesDir = join(ROOT, 'packages')
const packageDirs = readdirSync(packagesDir).filter((name) => {
  const full = join(packagesDir, name)
  return statSync(full).isDirectory() && name !== 'typescript-config' && name !== 'test-adapter-conformance'
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
  corrected.push({ name: pkg.name, before, after: canonicalVersion })
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
