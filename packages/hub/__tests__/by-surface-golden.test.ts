/**
 * Golden export-surface freeze for the `@noy-db/hub/by` seam.
 *
 * `/by` is what the `by-*` session-share transports bind — `by-peer`,
 * `by-tabs` — plus `@noy-db/test-mesh-conformance`.
 *
 * ⚠️ That was NOT true when the seam shipped in #1171. All three imported
 * `NoydbMesh` from `@noy-db/hub/cargo` instead, so `/by` was published with
 * **zero** binders — the exact "zero importers" condition the 0.4.0 prune
 * removed it for the first time. The subpath resolved, the barrel said "a
 * `by-*` transport binds ONLY to this subpath", the PR body said the
 * transports bound it, and none of it was checked. Fixed by migrating the
 * three, and by `family-port-has-binder` in check-architecture.mjs, which now
 * asks the question every run.
 *
 * ## Why this exists
 *
 * `/to` — the first family port — has been frozen since S5. `/at` and `/by`
 * shipped in the 0.7 line with no freeze at all, so the two seams a satellite
 * family was told to bind carried no stability guarantee, while the store
 * family's equivalent did. Adding an export needs a visible baseline update;
 * removing or renaming one fails loudly, which is the only signal a
 * third-party implementor gets.
 *
 * MECHANISM — identical to `to-surface-golden.test.ts`: runtime `Object.keys`
 * freezes the VALUE exports; a source parse of the `export [type] { … } from`
 * blocks freezes the TYPE-only exports (erased at runtime); a compile-time
 * type list asserts every baselined type still resolves, so a removal breaks
 * `typecheck` rather than only this file.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as port from '../src/port/by/index.js'
import type {
  DrainBarrierOptions,
  FenceState,
  NoydbMesh,
  WriterPresence,
} from '../src/port/by/index.js'

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

const baseline: Surface = JSON.parse(read('./by-surface.golden.json')) as Surface
const parsed = parseExports(read('../src/port/by/index.ts'))

describe('@noy-db/hub/by — golden export surface', () => {
  it('value exports match the frozen baseline (runtime enumeration)', () => {
    const runtime = Object.keys(port)
      .filter((k) => (port as Record<string, unknown>)[k] !== undefined)
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
type _FrozenTypes = [
  DrainBarrierOptions,
  FenceState,
  NoydbMesh,
  WriterPresence,
]
