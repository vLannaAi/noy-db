import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * #1097 follow-up — the caller-side check must be REACHABLE.
 *
 * `assertRosterEpochCurrent` shipped in `0.7.0-pre.9`, was listed in the
 * release notes under "what is new", and was exported from **no entry point**.
 * It was present in `dist/**\/*.d.ts` and importable from nowhere.
 *
 * That is worse than #1224, which was the same class one step less severe: a
 * predicate reachable from the WRONG seam (the root barrel, not `/to`, which is
 * all a store binds). This one was reachable from none — and the whole point of
 * an out-of-band anchor is that APPLICATION code performs the comparison. A
 * consumer told to assert a floor could not.
 *
 * Both were found the same way: someone tried to follow the documentation.
 */
describe('the roster-epoch caller API is reachable (#1097)', () => {
  it('is exported from the root barrel', async () => {
    const m = await import('../src/index.js')
    expect(typeof (m as Record<string, unknown>).assertRosterEpochCurrent).toBe('function')
  })

  it('INVARIANT: every exported member of roster-epoch.ts reaches a published entry point', () => {
    // Output-domain, not an enumeration of the two functions that exist today.
    // A helper added to this module later, and exported from nothing, fails
    // here rather than shipping unreachable and being found by a reader.
    const dir = fileURLToPath(new URL('../src/with-party/team/', import.meta.url))
    const src = readFileSync(`${dir}roster-epoch.ts`, 'utf8')
    const declared = [...src.matchAll(/^export function (\w+)/gm)].map(m => m[1] ?? '')
    expect(declared.length).toBeGreaterThan(0)   // the query must be able to find something

    const barrels = readdirSync(fileURLToPath(new URL('../src/', import.meta.url)))
    expect(barrels).toContain('index.ts')
    const rootBarrel = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')

    for (const name of declared) {
      expect(rootBarrel, `${name} is declared in roster-epoch.ts but exported from no barrel`)
        .toContain(name)
    }
  })
})
