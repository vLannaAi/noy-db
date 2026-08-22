/**
 * Regenerate `published-surface-<version>.json` from a PUBLISHED tarball.
 *
 * The baseline check-codemod-coverage.mjs compares against was originally
 * hand-assembled, with its provenance recorded only in a comment. That is the
 * shape this repo keeps catching elsewhere: a claim nothing can re-run. This
 * makes it reproducible.
 *
 *     node scripts/gen-published-surface.mjs 0.6.0
 *
 * Reads the registry (a read, not a publish-adjacent write), unpacks into a
 * temp dir, and computes the surface with the SAME `lib/surface.mjs` the
 * checks use — so the baseline and the thing measured against it cannot
 * disagree about what "the surface" means.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reachableExports } from './lib/surface.mjs'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function surfaceRecord(pkgDir, version) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const { all, bySubpath } = reachableExports(pkgDir)
  return {
    $comment:
      `Reachable export surface of the PUBLISHED @noy-db/hub@${version} tarball — the baseline for ` +
      'check-codemod-coverage.mjs. Computed by the TypeScript checker over the unpacked tarball ' +
      '(npm pack), NOT from this working tree — the working tree is what the check compares against. ' +
      'Regenerate with scripts/gen-published-surface.mjs when a new stable publishes.',
    version,
    source: `npm pack @noy-db/hub@${version}`,
    // EVERY declared exports key, including the codemods/*.json data entries.
    // Retiring any of them breaks a consumer's import path, which is the
    // question this list exists to answer — narrower than "has a .d.ts".
    subpaths: Object.keys(manifest.exports ?? {}).sort(),
    // How many of those carry a resolvable type surface. Kept separate so the
    // two counts cannot be confused for each other.
    typedSubpaths: bySubpath.size,
    exports: [...all].sort(),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]
  if (!version) {
    console.error('usage: node scripts/gen-published-surface.mjs <version>')
    process.exit(1)
  }
  const dir = mkdtempSync(join(tmpdir(), 'noydb-surface-'))
  execFileSync('npm', ['pack', `@noy-db/hub@${version}`, '--silent'], { cwd: dir, stdio: 'inherit' })
  const tgz = readdirSync(dir).find((f) => f.endsWith('.tgz'))
  if (!tgz) {
    console.error(`✗ npm pack produced no tarball for ${version}`)
    process.exit(1)
  }
  execFileSync('tar', ['xzf', tgz], { cwd: dir })
  const record = surfaceRecord(join(dir, 'package'), version)
  const out = join(PKG, `scripts/published-surface-${version}.json`)
  writeFileSync(out, JSON.stringify(record, null, 2) + '\n')
  console.log(`✅ ${out}\n   ${record.subpaths.length} subpaths (${record.typedSubpaths} typed), ${record.exports.length} symbols`)
}
