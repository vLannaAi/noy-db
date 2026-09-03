/**
 * The scaffolder's central contract is a `package.json` for someone else's
 * machine — so "does the rendered manifest resolve" is the property to assert,
 * and #1313 is what happens when nothing does.
 *
 * #703 made every `@noy-db/*` pin `^{{NOYDB_VERSION}}`, filled from this
 * package's own version, on the premise that this package shares the family's
 * lockstep line. The premise silently became false: `scripts/release.mjs`
 * normalised only `@noy-db/*`-prefixed packages, this is the one unscoped
 * member, so it drifted to `0.3.x` while the line moved to `0.7.x` — and
 * `^0.3.4` has never matched a published hub. The unit tests substituted a
 * literal (`0.0.0-test.0`), so they exercised the substitution and never the
 * VALUE.
 *
 * Two gates, deliberately different:
 *
 * 1. **Structural, always on** — the REAL token value equals the workspace
 *    version of every package the templates pin. Lockstep is exact equality,
 *    so this needs no semver and no network, and it is exactly the invariant
 *    whose absence let #1313 ship.
 * 2. **Registry, opt-in** (`NOYDB_SCAFFOLD_INSTALL=1`) — render each template
 *    with the real token and run a real `npm install --package-lock-only`
 *    against public npm. Only meaningful AFTER the line it pins is published
 *    (a pre-publish tree pins a version npm has not seen yet), which is why it
 *    is not on by default: run it against the published cut, not `main`.
 */
import { describe, it, expect } from 'vitest'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { applyTokens, ownVersion, templateDir } from '../src/wizard/render.js'

const run = promisify(execFile)
const TEMPLATES = ['nuxt-default', 'vite-vue', 'vanilla', 'electron'] as const
const PACKAGES_DIR = path.resolve(new URL('..', import.meta.url).pathname, '..')

async function renderedManifest(name: string): Promise<Record<string, Record<string, string>>> {
  const raw = await readFile(path.join(templateDir(name), 'package.json'), 'utf8')
  return JSON.parse(applyTokens(raw, {
    PROJECT_NAME: 'pins-probe', ADAPTER: 'browser', DEVTOOLS: 'false', SEED_INVOICES: '[]',
    NOYDB_VERSION: await ownVersion(),
  }))
}

function noydbDeps(pkg: Record<string, Record<string, string>>): Array<[string, string]> {
  return Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter(([k]) => k.startsWith('@noy-db/') || k === 'create-noy-db')
}

describe('the real {{NOYDB_VERSION}} resolves (#1313)', () => {
  it('this package is ON the lockstep line: ownVersion() equals @noy-db/hub\'s workspace version', async () => {
    const hub = JSON.parse(await readFile(path.join(PACKAGES_DIR, 'hub', 'package.json'), 'utf8'))
    expect(await ownVersion()).toBe(hub.version)
  })

  it.each(TEMPLATES)('%s: every rendered pin names the workspace version of the package it pins', async (name) => {
    const own = await ownVersion()
    for (const [dep, range] of noydbDeps(await renderedManifest(name))) {
      expect(range, `${name}: ${dep}`).toBe(`^${own}`)
      const dir = dep === 'create-noy-db' ? 'create-noy-db' : dep.slice('@noy-db/'.length)
      const pinned = JSON.parse(await readFile(path.join(PACKAGES_DIR, dir, 'package.json'), 'utf8'))
      // Lockstep is exact equality — so `^own` admits `pinned.version` by
      // construction, and a drift in either direction fails here, not on a
      // user's machine.
      expect(pinned.version, `${name}: ${dep} pins ^${own} but the workspace ships ${pinned.version}`).toBe(own)
    }
  })

  const registry = process.env.NOYDB_SCAFFOLD_INSTALL === '1' ? it : it.skip
  registry.each(TEMPLATES)('%s installs from public npm with the real token (NOYDB_SCAFFOLD_INSTALL=1)', async (name) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'noy-db-pins-'))
    try {
      await writeFile(path.join(dir, 'package.json'), JSON.stringify(await renderedManifest(name), null, 2))
      // --package-lock-only resolves the whole tree without extracting it;
      // no --legacy-peer-deps, which is the family's install criterion.
      await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir })
      const lock = JSON.parse(await readFile(path.join(dir, 'package-lock.json'), 'utf8'))
      for (const [dep] of noydbDeps(await renderedManifest(name))) {
        expect(lock.packages[`node_modules/${dep}`]?.version, `${name}: ${dep} did not resolve`).toBeTruthy()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
