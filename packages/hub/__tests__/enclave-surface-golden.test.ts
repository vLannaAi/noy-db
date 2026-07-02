/**
 * Golden export-surface freeze for `kernel/enclave/index.ts` — the fork-swap
 * contract (S5 family doors, Task 9).
 *
 * `kernel/enclave/` (crypto.ts + record-keys/**) is the hub's crypto
 * interior — the piece a forked sister project replaces wholesale, honoring
 * only this barrel's interface. This test freezes its export list against a
 * checked-in baseline (`enclave-surface.golden.json`) so drift fails CI —
 * adding requires a visible baseline update, removing / renaming fails
 * loudly. Not a published `@noy-db/hub/*` subpath (internal to the kernel
 * spine) — the golden discipline still applies because forks depend on it.
 *
 * MECHANISM — identical to the `/to` golden test (see its header for the
 * rationale): runtime `Object.keys` freezes the VALUE exports; a source-parse
 * of the `export [type] { … } from` blocks freezes both VALUE and TYPE-only
 * exports; a compile-time `import type` list asserts every baselined type
 * still resolves so a removal also breaks `typecheck`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as enclave from '../src/kernel/enclave/index.js'
import type { DeterministicContext, SealingContext } from '../src/kernel/enclave/index.js'

interface Surface {
  readonly values: readonly string[]
  readonly types: readonly string[]
}

function read(url: string): string {
  return readFileSync(fileURLToPath(new URL(url, import.meta.url)), 'utf8')
}

/** Strip comments, then collect names from `export [type] { … } from` blocks. */
function parseExports(src: string): { values: string[]; types: string[] } {
  const clean = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const collect = (re: RegExp): string[] => {
    const out = new Set<string>()
    for (const m of clean.matchAll(re)) {
      for (const part of (m[1] ?? '').split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) out.add(name)
      }
    }
    return [...out].sort()
  }
  return {
    types: collect(/export\s+type\s*\{([^}]*)\}\s*from/g),
    values: collect(/export\s*\{([^}]*)\}\s*from/g),
  }
}

const baseline: Surface = JSON.parse(read('./enclave-surface.golden.json')) as Surface
const parsed = parseExports(read('../src/kernel/enclave/index.ts'))

describe('kernel/enclave — golden export surface (fork-swap contract)', () => {
  it('value exports match the frozen baseline (runtime enumeration)', () => {
    const runtime = Object.keys(enclave)
      .filter((k) => (enclave as Record<string, unknown>)[k] !== undefined)
      .sort()
    expect(runtime).toEqual([...baseline.values].sort())
  })

  it('value exports in source match the baseline (source parse)', () => {
    expect(parsed.values).toEqual([...baseline.values].sort())
  })

  it('type exports match the frozen baseline (source parse)', () => {
    expect(parsed.types).toEqual([...baseline.types].sort())
  })
})

// Compile-time exhaustiveness: every baselined type must still be exported.
type _FrozenTypes = [DeterministicContext<unknown>, SealingContext]
