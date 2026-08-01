/**
 * Assemble docs-bridge.json for noy-db's essential `to-*` stores (#913).
 *
 * Producer parity with noy-db-to (spec:
 * `noy-db-to/docs/superpowers/specs/2026-07-30-docs-bridge-design.md`) — same
 * `bridge: 1` schema, so `noy-db-docs/scripts/sync/bridge.mjs` parses either
 * repo's payload unchanged. Pure given its inputs; the CLI at the bottom wires
 * the real fs/npm.
 *
 * Two deliberate divergences from the noy-db-to producer:
 *
 *   - Stores live under `packages/`, not at the repo root.
 *   - `hubPeerRange` is always null. Extended stores pin hub by a real semver
 *     range, so their payload carries one; in-repo stores pin `workspace:*`,
 *     a workspace directive rather than a consumer-meaningful range. The
 *     lockstep `version` already answers "which hub".
 *
 * changeType rule (ordered): "added" when isFirstPublish(name) — the package
 * has no published version before this release; else "updated" when the
 * CHANGELOG has a section for this version; else "version-only".
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { extractSection } from './changelog.mjs'

export function buildPayload({ rootDir, caps, tag, channel, runUrl, isFirstPublish }) {
  const packagesDir = join(rootDir, 'packages')
  // The canonical lockstep version comes from `packages/hub`, not the root
  // package.json — noy-db's root is a private `0.0.0` shell. (noy-db-to's
  // producer reads its root, because there the root IS the versioned package.)
  const canonicalVersion = JSON.parse(
    readFileSync(join(packagesDir, 'hub', 'package.json'), 'utf8'),
  ).version
  const dirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('to-'))
    .map(d => d.name)
    .sort()

  const packages = dirs.map(dir => {
    const pkg = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'))
    const cap = caps[dir]
    if (!cap) throw new Error(`${dir}: no entry in the capability dump — add it to the WIRING table in scripts/__tests__/docs-bridge-capabilities.test.ts`)

    const clPath = join(packagesDir, dir, 'CHANGELOG.md')
    const changelog = existsSync(clPath) ? extractSection(readFileSync(clPath, 'utf8'), pkg.version) : null
    const changeType = isFirstPublish(pkg.name) ? 'added' : changelog !== null ? 'updated' : 'version-only'

    return {
      name: pkg.name, dir, version: pkg.version, description: pkg.description ?? null,
      factory: cap.factory, shape: cap.shape, capabilities: cap.capabilities,
      optionDependent: cap.optionDependent, changeType, changelog,
      // #930 — WHICH bits vary with the wiring (store-level `optionDependent`
      // only says "something varies"). Additive: omitted when the dump lists
      // none, so pre-#930 consumers parse the payload unchanged.
      ...(Array.isArray(cap.conditionalBits) && cap.conditionalBits.length > 0
        ? { conditionalBits: cap.conditionalBits }
        : {}),
    }
  })

  return {
    bridge: 1, repo: 'vLannaAi/noy-db',
    version: canonicalVersion, tag, channel, runUrl, hubPeerRange: null, packages,
  }
}

/**
 * True when a failed `npm view` call means the package has never been published
 * (npm's E404). Any other failure (network blip, registry outage, auth error, …)
 * is NOT first-publish — the caller should rethrow rather than silently guessing,
 * because mislabelling one tells the docs side to write a brand-new page for a
 * store that has shipped for months.
 */
export function isFirstPublishFromError(err) {
  const text = `${err?.stderr ?? ''}${err?.stdout ?? ''}`.toString()
  return text.includes('E404')
}

/** True when npm knows no version of this package other than the current one. */
export function npmIsFirstPublish(name) {
  try {
    const out = execFileSync('npm', ['view', name, 'versions', '--json'], { stdio: 'pipe' }).toString()
    const versions = JSON.parse(out)
    const list = Array.isArray(versions) ? versions : [versions]
    return list.length <= 1
  } catch (err) {
    if (isFirstPublishFromError(err)) return true // not on the registry at all
    throw err // transient/other npm failure — fail visibly, don't mislabel
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const get = flag => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1] }
  const capsFile = get('--caps'); const tag = get('--tag'); const channel = get('--channel'); const runUrl = get('--run-url')
  if (!capsFile || !tag || !channel || !runUrl) {
    console.error('usage: build-payload.mjs --caps <file> --tag <git-tag> --channel <dist-tag> --run-url <url>')
    process.exit(1)
  }
  const caps = JSON.parse(readFileSync(capsFile, 'utf8'))
  const payload = buildPayload({ rootDir: process.cwd(), caps, tag, channel, runUrl, isFirstPublish: npmIsFirstPublish })
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
}
