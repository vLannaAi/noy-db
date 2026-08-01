#!/usr/bin/env node
/**
 * scripts/repoint-pre-only-latest.mjs
 *
 * Move the npm `latest` dist-tag for packages that have NO stable release.
 *
 * ## Why this exists
 *
 * npm sets `latest` on a package's FIRST publish regardless of `--tag`, and
 * every later `--tag next` publish leaves it alone. A package born inside a
 * pre-release line therefore has `latest` pinned to its debut version forever,
 * drifting further behind on every release while nothing complains.
 *
 * `@noy-db/in-liff` and `@noy-db/in-pwa` (earliest version 0.4.0-pre.2, no
 * 0.3.x at all) sat EIGHT releases stale before anyone noticed — `npm i` on
 * them resolved a build predating the pre.7 renames. Moving the tag by hand
 * fixed one instance; the next release re-broke it, because the mechanism was
 * untouched.
 *
 * For these packages `latest` cannot be "correct" — there is no stable release
 * to point at — so the choice is between CURRENT and STALE, and stale is
 * strictly worse.
 *
 * ## Usage
 *
 *   node scripts/repoint-pre-only-latest.mjs [--version=X] [--dry-run]
 *
 * Called from `release.yml` after a prerelease publish, and from
 * `dist-tags.yml` for a manual repair when a release has already shipped.
 * Requires `NODE_AUTH_TOKEN` (the CI automation token) — that token bypasses
 * 2FA, which a workstation `npm dist-tag add` cannot do without an OTP.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, appendFileSync } from 'node:fs'

/**
 * Packages with no stable release, whose `latest` must track the current
 * prerelease.
 *
 * EMPTIED at the 0.5.0 stable cut: `in-liff` and `in-pwa` graduated with the
 * 0.4.0 stable (their `latest` is a real release now), so the script is a
 * no-op until a NEW package debuts mid-pre-line. Before adding a name, ask
 * whether the package should simply be held back until the stable release
 * instead — that is almost always the better answer.
 */
const PRE_ONLY = []

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const versionArg = args.find(a => a.startsWith('--version='))?.slice('--version='.length)

const version =
  versionArg ?? JSON.parse(readFileSync('packages/hub/package.json', 'utf8')).version

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[repoint] refusing to act on a version that does not look like semver: ${version}`)
  process.exit(1)
}

const summary = []
const note = (line) => {
  console.log(`[repoint] ${line}`)
  summary.push(line)
}

note(`target version: ${version}${dryRun ? ' (dry run)' : ''}`)

for (const pkg of PRE_ONLY) {
  let current = ''
  try {
    current = execFileSync('npm', ['view', pkg, 'dist-tags.latest'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    note(`- \`${pkg}\` — skipped, not on npm`)
    continue
  }

  if (!current) {
    note(`- \`${pkg}\` — skipped, no \`latest\` tag`)
    continue
  }

  // Only ever move a tag that is ALREADY on a prerelease. If `latest` points at
  // a stable version the package has graduated, and dragging it back onto a
  // pre-release would be a real regression — so refuse, loudly enough that the
  // name gets removed from PRE_ONLY.
  if (!current.includes('-')) {
    note(`- \`${pkg}\` — **skipped**, \`latest\` is stable (${current}); remove it from PRE_ONLY`)
    continue
  }

  if (current === version) {
    note(`- \`${pkg}\` — already at ${version}`)
    continue
  }

  if (dryRun) {
    note(`- \`${pkg}\` — would move \`latest\`: ${current} → ${version}`)
    continue
  }

  try {
    execFileSync('npm', ['dist-tag', 'add', `${pkg}@${version}`, 'latest'], { stdio: 'pipe' })
    note(`- \`${pkg}\` — \`latest\`: ${current} → ${version}`)
  } catch (err) {
    // Never fail the caller. In the release flow the publish has already
    // succeeded by this point, and a wedged dist-tag is recoverable by hand;
    // turning a cosmetic problem into a red release only trains people to stop
    // reading the log.
    const detail = (err?.stderr?.toString() ?? err?.message ?? '').split('\n')[0]
    note(`- \`${pkg}\` — ⚠️ FAILED (still ${current}): ${detail}`)
    note(`    recover with: \`npm dist-tag add ${pkg}@${version} latest\``)
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Pre-only \`latest\` re-point\n\n${summary.join('\n')}\n\n`,
  )
}
