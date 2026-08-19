#!/usr/bin/env node
/**
 * scripts/align-next-to-stable.mjs
 *
 * After a STABLE publish, point `next` at the stable too.
 *
 * ## Why this exists
 *
 * The two channels carry an invariant: `@next` runs AHEAD of `@latest`. A
 * stable cut breaks it mechanically and with nobody making a mistake —
 * `0.6.0 > 0.6.0-pre.24`, because a prerelease sorts BELOW its own release, so
 * the moment `latest` moves to the stable, `next` is behind it for every
 * package at once. Nothing is broken; the tags simply stop meaning what the
 * family says they mean, and the sweep starts reporting a lying tag across the
 * whole line.
 *
 * Pointing both tags at the stable is self-correcting: the next prerelease
 * publish moves `next` forward again and the invariant returns on its own.
 *
 * ## This is NOT `repoint-pre-only-latest.mjs`, and the difference is the
 * ## FAILURE POSTURE — do not "fix" this to match it
 *
 * That script never fails its caller, deliberately: a stale `latest` on a
 * pre-only package is cosmetic, and reddening a release over it only trains
 * people to stop reading the log.
 *
 * This one runs as part of DELIVERING A STABLE, across every package that
 * ships together. A half-applied state here is worse than a loud failure — it
 * is precisely the state a human then repairs by hand, and a workstation
 * `npm dist-tag add` needs an interactive OTP that CI never has to supply.
 * So: exit non-zero, and print the recovery command for every package that did
 * not land.
 *
 * ## Usage
 *
 *   node scripts/align-next-to-stable.mjs --version=0.6.0 [--dry-run]
 *
 * The version is pushed IN as a parameter rather than read from CI context, so
 * the whole thing is runnable from a terminal. It has to be: the trigger that
 * fires it in anger (`release` with `prerelease == false`) cannot happen until
 * a real stable cut, so a step that reached into `github.*` could only ever be
 * tested by cutting one.
 *
 * Requires `NODE_AUTH_TOKEN` (the CI automation token). That token bypasses
 * 2FA — verified from CI, and bounded to `dist-tag`: `npm deprecate` has NOT
 * been shown to work without an OTP and must not be assumed to.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Packages on their own version line, which the lockstep normalizer skips.
 * Excluded BY NAME rather than left to the version check below, so that a day
 * when its version coincidentally matches does not silently enrol it.
 */
export const OWN_VERSION_LINE = ['create-noy-db']

/** A prerelease sorts below its own release — the entire reason this exists. */
const isPrerelease = (v) => v.includes('-')

/**
 * DERIVED, never hardcoded. A hardcoded roster is what broke noy-db-to's docs
 * bridge twice: `to-browser-fs` debuted as the 18th store, was never added to
 * the list it needed to be in, and the build died on the first unregistered
 * entry — twice, with both runs green.
 */
export function derivePackages(packagesDir, readManifest, readDir = readdirSync) {
  const out = []
  for (const dir of readDir(packagesDir).sort()) {
    let m
    try {
      m = readManifest(join(packagesDir, dir, 'package.json'))
    } catch {
      continue // not a package directory
    }
    if (!m?.name || m.private === true) continue
    out.push({ pkg: m.name, version: m.version })
  }
  return out
}

/**
 * Split the derived set into what we will act on and what we will not, with a
 * stated reason for every exclusion. A package left out silently is
 * indistinguishable from a package that was never there.
 */
export function planAlignment(derived, target) {
  const targets = []
  const excluded = []
  for (const { pkg, version } of derived) {
    if (OWN_VERSION_LINE.includes(pkg)) {
      excluded.push({ pkg, why: `own version line (${version}); not part of the lockstep cut` })
      continue
    }
    if (version !== target) {
      // Not a skip. Every lockstep package is normalized to one version before
      // a release, so a mismatch means the normalizer did not run or did not
      // finish — and aligning the rest would leave a partial line.
      excluded.push({ pkg, why: `LOCKSTEP VIOLATION: manifest says ${version}, expected ${target}` })
      continue
    }
    targets.push({ pkg, version })
  }
  return { targets, excluded, lockstepBroken: excluded.some((e) => e.why.startsWith('LOCKSTEP')) }
}

/**
 * THE LOAD-BEARING HALF, extracted as a pure function so it is testable at
 * all. It never fires in a passing run, which is exactly why it would
 * otherwise go uncovered while the easy derivation logic got all the tests.
 *
 * The catastrophic case it exists for: a wrong `--version` turns this into
 * `npm dist-tag add <pkg>@<never-published> next` across the whole line. So
 * the check is not "did the publish succeed" but "is `latest` ALREADY exactly
 * where this run claims it is" — which is only true if the publish this run is
 * finishing is the one that put it there.
 */
export function decideAction(tags, version) {
  if (isPrerelease(version)) {
    return { action: 'refuse', why: `${version} is a prerelease; this job only follows a STABLE publish` }
  }
  if (tags.latest === undefined) {
    return { action: 'refuse', why: 'no `latest` tag on the registry — cannot confirm the stable published' }
  }
  if (tags.latest !== version) {
    return {
      action: 'refuse',
      why: `\`latest\` is ${tags.latest}, not ${version} — refusing to point \`next\` at a version this run did not publish`,
    }
  }
  if (tags.next === version) return { action: 'skip', why: `\`next\` already at ${version}` }
  return { action: 'align', why: `\`next\`: ${tags.next ?? '(none)'} → ${version}` }
}

// ── everything below is I/O; the decisions above are pure ──────────────────

function readDistTags(pkg) {
  const raw = execFileSync('npm', ['view', pkg, 'dist-tags', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(raw || '{}')
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const version = args.find((a) => a.startsWith('--version='))?.slice('--version='.length)

  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`[align] --version=X.Y.Z is required (got: ${version ?? 'nothing'})`)
    process.exit(1)
  }

  const summary = []
  const note = (line) => {
    console.log(`[align] ${line}`)
    summary.push(line)
  }
  const flush = (heading) => {
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${heading}\n\n${summary.join('\n')}\n\n`)
    }
  }

  // npm reports write-path auth failures as 404, never 401 — deliberately, so
  // status codes cannot be used to probe which private packages exist. Without
  // establishing identity first, a later 404 is ambiguous between a dead
  // credential and a missing package, and the wrong one gets investigated.
  if (!dryRun) {
    try {
      const who = execFileSync('npm', ['whoami'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      note(`authenticated as \`${who}\``)
    } catch {
      note('❌ `npm whoami` failed — no usable credential. Every later 404 would be ambiguous.')
      flush('npm dist-tag alignment — ABORTED')
      process.exit(1)
    }
  }

  const derived = derivePackages('packages', (p) => JSON.parse(readFileSync(p, 'utf8')))
  const { targets, excluded, lockstepBroken } = planAlignment(derived, version)

  note(`target ${version} · ${targets.length} package(s) · ${excluded.length} excluded`)
  for (const e of excluded) note(`- \`${e.pkg}\` — excluded: ${e.why}`)

  if (lockstepBroken) {
    note('❌ refusing to align a partially-normalized line. Fix the versions and re-run.')
    flush('npm dist-tag alignment — ABORTED')
    process.exit(1)
  }

  const failed = []
  for (const { pkg } of targets) {
    let tags
    try {
      tags = readDistTags(pkg)
    } catch (err) {
      const detail = (err?.stderr?.toString() ?? err?.message ?? '').split('\n')[0]
      note(`- \`${pkg}\` — ❌ could not read dist-tags: ${detail}`)
      failed.push(pkg)
      continue
    }

    const { action, why } = decideAction(tags, version)
    if (action === 'refuse') {
      note(`- \`${pkg}\` — ❌ REFUSED: ${why}`)
      failed.push(pkg)
      continue
    }
    if (action === 'skip') {
      note(`- \`${pkg}\` — ${why}`)
      continue
    }
    if (dryRun) {
      note(`- \`${pkg}\` — would align ${why}`)
      continue
    }

    try {
      execFileSync('npm', ['dist-tag', 'add', `${pkg}@${version}`, 'next'], { stdio: 'pipe' })
    } catch (err) {
      const detail = (err?.stderr?.toString() ?? err?.message ?? '').split('\n')[0]
      note(`- \`${pkg}\` — ❌ FAILED: ${detail}`)
      failed.push(pkg)
      continue
    }

    // A zero exit is not evidence the tag moved. Ask the registry.
    try {
      const after = readDistTags(pkg)
      if (after.next !== version) {
        note(`- \`${pkg}\` — ❌ command succeeded but \`next\` is ${after.next ?? '(none)'}`)
        failed.push(pkg)
        continue
      }
      note(`- \`${pkg}\` — ✅ ${why}`)
    } catch {
      note(`- \`${pkg}\` — ⚠️ moved, but the verify read failed; confirm by hand`)
      failed.push(pkg)
    }
  }

  if (failed.length > 0) {
    note('')
    note(`❌ **${failed.length} package(s) did not land. The line is HALF-APPLIED.**`)
    note('Recover from a workstation (these need an interactive OTP):')
    note('```')
    for (const pkg of failed) note(`npm dist-tag add ${pkg}@${version} next --otp=<code>`)
    note('```')
    flush('npm dist-tag alignment — FAILED')
    process.exit(1)
  }

  note(`✅ \`next\` and \`latest\` both at ${version} across ${targets.length} package(s)`)
  flush('npm dist-tag alignment')
}

// Importing this module must not perform a release action.
if (process.argv[1] && process.argv[1].endsWith('align-next-to-stable.mjs')) main()
