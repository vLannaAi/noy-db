/**
 * #1458 — the COMPILE-TIME half of the split, in both directions.
 *
 * The runtime stub (`1458-query-tiers-stubs.test.ts`) is the backstop; this is
 * the primary signal. `.join()` without `@noy-db/hub/query/relate` must not
 * typecheck, and with it must typecheck INCLUDING the alias's type — a method
 * that arrived as `any` would compile both fixtures and prove nothing.
 *
 * ⛔ **Why this cannot be an ordinary `*.test-d.ts`.** A `declare module`
 * augmentation is PROGRAM-WIDE, not import-gated: the moment any file in the
 * program pulls in `query/relate/index.ts`, `join` exists on `Query`
 * everywhere. `tsconfig.typetest.json` includes `src`, and `src/index.ts`
 * imports all three groups — so the negative case is unprovable there by
 * construction. It needs its own tiny program, which is what the two
 * fixture tsconfigs are.
 *
 * ⭐ That same property is the FEATURE, not a workaround: it is why a consumer
 * writes the import once at their app's entry rather than in every file that
 * joins.
 *
 * ⚠️ It is also a hazard, and `check-architecture.mjs`'s `query-tiers` check
 * guards it: a file that type-imports a GROUP BARREL drags the augmentation
 * into every program that reaches it, and the compile error silently stops
 * being raised. That is how this test first passed when it should have failed
 * — `kernel/collection.ts` had `import type { JoinContext } from
 * './query/relate/index.js'`, and Find-only consumers inherited `join`.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = 'packages/hub/__tests__/fixtures/1458-query-tiers'
// pnpm hoists typescript to the workspace root; the package has no local copy.
const TSC = join(HUB, '../../node_modules/typescript/bin/tsc')

function typecheck(project: string): { code: number; output: string } {
  try {
    const output = execFileSync(
      'node',
      [TSC, '--noEmit', '-p', join(HUB, `__tests__/fixtures/1458-query-tiers/${project}`)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { code: 0, output }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('#1458 — the method and its type arrive together', () => {
  it('REFUSES .join() when @noy-db/hub/query/relate is not imported', () => {
    const { code, output } = typecheck('tsconfig.without.json')
    expect(code, `expected tsc to fail on ${FIXTURES}/without-relate.ts:\n${output}`).not.toBe(0)
    // The failure must be the RIGHT one. A fixture that stopped compiling for
    // an unrelated reason (a moved path, a renamed export) would satisfy a
    // bare `not.toBe(0)` forever while the property went unchecked.
    expect(output).toMatch(/Property 'join' does not exist on type 'Query</)
    // …and only that one: the Find chain above it must still compile.
    expect(output).not.toMatch(/Property '(where|orderBy|limit|toArray)' does not exist/)
  })

  it('ACCEPTS the identical call once the subpath is imported, alias type and all', () => {
    const { code, output } = typecheck('tsconfig.with.json')
    expect(code, `expected tsc to succeed on ${FIXTURES}/with-relate.ts:\n${output}`).toBe(0)
  })
})
