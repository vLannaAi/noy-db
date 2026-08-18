/**
 * `kernel/query/live.ts` names the framework bindings that wrap a `LiveQuery`.
 * That claim must stay true, and nothing compiles a doc comment (#1131).
 *
 * The comment previously said "the Vue layer wraps a `LiveQuery` … React/Solid/
 * Svelte adapters do the same" — describing four adapters, none of which
 * existed. A pilot consumer read it, went looking in `@noy-db/in-vue`, found
 * nothing, and hand-rolled the subscription glue (getting the `error`
 * semantics wrong is the usual outcome) while a correct wrapper sat in
 * `@noy-db/in-pinia` the whole time.
 *
 * Same defect class as #1072/#1063: prose that no gate reads. This asserts on
 * the OUTPUT — which packages actually call `.live()` — rather than on the
 * comment's wording, so it catches a new wrapper appearing as well as the
 * named one disappearing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Packages documented in live.ts as wrapping a LiveQuery. Keep in sync with
 * that comment.
 *
 * `in-vue` OWNS the wrapper (`useLiveQuery`); `in-pinia` delegates to it and
 * still constructs the query, so both legitimately touch `LiveQuery` and both
 * are named in the comment.
 */
const DOCUMENTED_WRAPPERS = ['in-pinia', 'in-vue']

function tsFilesUnder(dir: string): string[] {
  let out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out = out.concat(tsFilesUnder(full))
    else if (entry.endsWith('.ts') && !entry.includes('.test.')) out.push(full)
  }
  return out
}

describe('live() framework bindings', () => {
  it('only the documented packages wrap a LiveQuery', () => {
    const pkgRoot = join(REPO_ROOT, 'packages')
    const callers = readdirSync(pkgRoot)
      .filter(p => p !== 'hub')
      .filter(p => {
        const src = join(pkgRoot, p, 'src')
        try {
          return statSync(src).isDirectory()
        } catch {
          return false
        }
      })
      .filter(p =>
        tsFilesUnder(join(pkgRoot, p, 'src')).some(f =>
          /\.live\(\)|LiveQuery/.test(readFileSync(f, 'utf8')),
        ),
      )
      .sort()

    // Fails in BOTH directions on purpose: a new wrapper that live.ts does not
    // mention is as much a doc defect as a documented one that vanished.
    expect(callers).toEqual([...DOCUMENTED_WRAPPERS].sort())
  })

  it('live.ts names each documented wrapper', () => {
    const doc = readFileSync(
      join(REPO_ROOT, 'packages/hub/src/kernel/query/live.ts'),
      'utf8',
    )
    for (const pkg of DOCUMENTED_WRAPPERS) {
      expect(doc).toContain(`@noy-db/${pkg}`)
    }
  })
})
