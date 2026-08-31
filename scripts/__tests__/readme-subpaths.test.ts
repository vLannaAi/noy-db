/**
 * Every `@noy-db/hub/<subpath>` taught in the repo's front-page prose must
 * exist in hub's published `exports` map (#1063).
 *
 * #1052 made the compiler enforce the pod rename and it worked perfectly for
 * code — zero executable references left across six repos. But **nothing
 * compiles a README**, so `README.md` and `SERVICES.md` went on teaching
 * `import { withAggregate } from '@noy-db/hub/aggregate'` for two release
 * lines after that subpath was deleted. Copying either snippet failed at
 * install-time resolution.
 *
 * Prose is the one category with no gate. This is the cheapest possible one:
 * it does not typecheck the snippets, only that the subpaths they name are
 * real.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const read = (rel: string): string => readFileSync(REPO_ROOT + rel, 'utf8')

const hubExports = Object.keys(
  (JSON.parse(read('packages/hub/package.json')) as { exports: Record<string, unknown> }).exports,
)

/** `./history` → `@noy-db/hub/history`; `.` → the bare root. */
const validSpecifiers = new Set(
  hubExports.map(k => (k === '.' ? '@noy-db/hub' : `@noy-db/hub/${k.replace(/^\.\//, '')}`)),
)

/** Every `@noy-db/hub…` specifier inside a fenced code block. */
function hubSpecifiersInFences(md: string): string[] {
  const fences = md.match(/```[\s\S]*?```/g) ?? []
  const found = new Set<string>()
  for (const fence of fences) {
    for (const m of fence.matchAll(/from\s+'(@noy-db\/hub(?:\/[\w./-]+)?)'/g)) found.add(m[1]!)
    for (const m of fence.matchAll(/import\s*\(\s*'(@noy-db\/hub(?:\/[\w./-]+)?)'\s*\)/g)) found.add(m[1]!)
  }
  return [...found].sort()
}

describe('front-page prose teaches only real hub subpaths (#1063)', () => {
  // SERVICES.md moved to the private family layer (2026-08-31 restructure);
  // the same subpath check runs there via tools/check-private-prose.mjs.
  for (const file of ['README.md'] as const) {
    it(`${file} names no deleted subpath`, () => {
      const used = hubSpecifiersInFences(read(file))
      expect(used.length, `${file}: expected some @noy-db/hub imports in fences`).toBeGreaterThan(0)
      const dead = used.filter(u => !validSpecifiers.has(u))
      expect(dead, `${file} teaches subpath(s) absent from hub's exports map`).toEqual([])
    })
  }

  it('the check would have caught the real #1063 regression', () => {
    // `/aggregate` was deleted in the 0.6 line (aggregate → reduce). Proves
    // this test can fail, rather than passing because the regex matched nothing.
    expect(validSpecifiers.has('@noy-db/hub/aggregate')).toBe(false)
    expect(validSpecifiers.has('@noy-db/hub/reduce')).toBe(true)
    const dead = hubSpecifiersInFences(
      "```ts\nimport { withAggregate } from '@noy-db/hub/aggregate'\n```",
    ).filter(u => !validSpecifiers.has(u))
    expect(dead).toEqual(['@noy-db/hub/aggregate'])
  })
})
