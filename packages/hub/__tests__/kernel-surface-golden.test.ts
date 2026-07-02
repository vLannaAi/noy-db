/**
 * Golden export-surface freeze for the `@noy-db/hub/kernel` seam (Phase 3).
 *
 * The `/kernel` subpath is a curated contract klum-db binds to ("additive
 * changes only; removals are breaking"). Until now that intent lived only in
 * JSDoc prose with zero enforcement. This test freezes the export list against
 * a checked-in baseline (`kernel-surface.golden.json`) so drift fails CI:
 *   - ADDING an export fails until the baseline is updated (visible, reviewed).
 *   - REMOVING / RENAMING an export fails loudly.
 *
 * MECHANISM (two halves, because TS type-only exports are erased at runtime):
 *   1. VALUE exports (runtime helpers + error classes) — enumerated at runtime
 *      via `Object.keys(import * as kernel)`, the same approach as the in-family
 *      precedent `nit-db/packages/hub/test/parity.test.ts`.
 *   2. TYPE-only exports — cannot be runtime-enumerated, so they are frozen by
 *      PARSING the `export type { … } from` blocks out of the source `index.ts`
 *      and diffing against the baseline. A compile-time `import type` list below
 *      additionally asserts every baselined type still resolves, so a removal /
 *      rename also breaks `typecheck`, not just this test.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as kernel from '../src/legacy/kernel.js'
import type {
  AggregateResult, AggregateSpec, ChangeEvent, Collection, CollectionMeta,
  CoordinationProvider, DrainBarrierOptions, FenceState, FuseOptions, IndexDef,
  JoinStrategy, LiveAggregation, LiveQuery, Noydb, Operator, Query,
  RetrieveHit, RetrieveOptions, Vault, VaultMeta, WriterPresence,
} from '../src/legacy/kernel.js'

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

const baseline: Surface = JSON.parse(read('./kernel-surface.golden.json')) as Surface
const parsed = parseExports(read('../src/legacy/kernel.ts'))

describe('@noy-db/hub/kernel — golden export surface', () => {
  it('value exports match the frozen baseline (runtime enumeration)', () => {
    const runtime = Object.keys(kernel)
      .filter((k) => (kernel as Record<string, unknown>)[k] !== undefined)
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
// A removal/rename breaks `typecheck` here in addition to the source-parse test.
type _FrozenTypes = [
  AggregateResult<AggregateSpec>, AggregateSpec, ChangeEvent,
  Collection<Record<string, unknown>>, CollectionMeta, CoordinationProvider,
  DrainBarrierOptions, FenceState, FuseOptions, IndexDef, JoinStrategy,
  LiveAggregation<Record<string, unknown>>, LiveQuery<Record<string, unknown>>,
  Noydb, Operator, Query<Record<string, unknown>>, RetrieveHit<Record<string, unknown>>, RetrieveOptions,
  Vault, VaultMeta, WriterPresence,
]
