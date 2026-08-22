/**
 * Published prose must not teach a name a codemod map retired.
 *
 * `readme-subpaths.test.ts` (#1063) checks that prose names only real
 * SUBPATHS. It cannot see a retired SYMBOL, and that is what rotted:
 *
 *   - five `at-*` READMEs still taught `envSealingProvider`,
 *     `awsKmsSealingProvider`, `SealingKeyProvider` … renamed days earlier
 *     in the 0.7 line, and all five READMEs ship in `files`.
 *   - `create-noy-db`'s electron and vanilla templates taught
 *     `import { jsonFile } from '@noy-db/to-file'` and `browserIdbStore()`.
 *     `templates/` ships, so a scaffolded project's README opened with an
 *     import that does not resolve.
 *
 * Nothing compiles a README. The compiler enforced those renames perfectly
 * for code — zero executable references left — and prose is the one category
 * with no gate, which is exactly the gap #1063 named and only half closed.
 *
 * ## Scope, deliberately narrow
 *
 * Only files that SHIP (`package.json`'s `files`), and only rows the map
 * marks `safeGlobalReplace: true` — the map annotates its own unsafe rows
 * precisely because they are bare nouns (`s3`, `min`, `count`, `drive`), and
 * flagging those would train people to ignore this check.
 *
 * Documents whose JOB is to name the old symbol are exempt by path:
 * `MIGRATING.md` and `CHANGELOG.md` describe the rename, and rewriting them
 * would falsify the record — the repo's standing policy is that historical
 * records stay as written while live documentation migrates.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PACKAGES = join(ROOT, 'packages')

/** Names retired by a shipped map, safe to search for as whole words. */
function retiredNames(): string[] {
  const dir = join(PACKAGES, 'hub/codemods')
  const names = new Set<string>()
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const map = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
      renames?: { from: string; safeGlobalReplace?: boolean; kind?: string }[]
    }
    for (const row of map.renames ?? []) {
      // Subpaths are #1063's job and are matched differently (a specifier,
      // not a word). Unsafe rows are bare nouns by the map's own annotation.
      if (row.safeGlobalReplace !== true) continue
      if (row.kind === 'subpath') continue
      names.add(row.from)
    }
  }
  return [...names]
}

/** Every file a package actually publishes, resolved from `files`. */
function shippedDocs(pkgDir: string): string[] {
  const manifestPath = join(pkgDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: string[] }
  const out: string[] = []
  const walk = (p: string): void => {
    if (!existsSync(p)) return
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p)) walk(join(p, e))
      return
    }
    if (!p.endsWith('.md')) return
    const base = p.split('/').pop()!
    // See the header: these exist to record the rename.
    if (base === 'MIGRATING.md' || base === 'CHANGELOG.md') return
    out.push(p)
  }
  for (const entry of manifest.files ?? []) {
    if (entry === 'dist') continue // built output mirrors src, checked by the compiler
    walk(join(pkgDir, entry))
  }
  return out
}

describe('shipped prose teaches no retired name', () => {
  const names = retiredNames()

  it('has rows to check — a silent empty list would pass everything', () => {
    expect(names.length).toBeGreaterThan(50)
  })

  it('no published .md names a symbol a codemod map retired', () => {
    const offences: string[] = []
    for (const pkg of readdirSync(PACKAGES)) {
      const dir = join(PACKAGES, pkg)
      if (!statSync(dir).isDirectory()) continue
      for (const doc of shippedDocs(dir)) {
        const text = readFileSync(doc, 'utf8')
        for (const name of names) {
          if (new RegExp(`\\b${name}\\b`).test(text)) {
            offences.push(`${relative(ROOT, doc)} teaches '${name}'`)
          }
        }
      }
    }
    expect(offences, 'published prose is the one category with no compiler').toEqual([])
  })
})
