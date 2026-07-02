/**
 * Golden export-surface freeze for the `@noy-db/hub/in` seam (S5 family doors).
 *
 * A framework binding (`in-react`, `in-nuxt`, `in-vue`, `in-pinia`,
 * `in-tanstack-query`, `in-ai`, …) binds ONLY to this subpath: the handle
 * types it wraps (`Noydb`/`Vault`/`Collection`/`Query`/`LiveQuery`) plus the
 * change-event shape it observes (`ChangeEvent`). This test freezes its
 * export list against a checked-in baseline (`in-surface.golden.json`) so
 * drift fails CI — adding requires a visible baseline update, removing /
 * renaming fails loudly.
 *
 * MECHANISM — identical to the `/to` golden test (see its header for the
 * rationale). `/in` is type-only, so the runtime VALUE enumeration is
 * expected to be empty; the source-parse of the `export type { … } from`
 * blocks freezes the TYPE-only exports, and a compile-time `import type`
 * list asserts every baselined type still resolves so a removal also
 * breaks `typecheck`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as inDoor from '../src/kernel/in/index.js'
import type { Noydb, Vault, Collection, Query, LiveQuery, ChangeEvent } from '../src/kernel/in/index.js'

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

const baseline: Surface = JSON.parse(read('./in-surface.golden.json')) as Surface
const parsed = parseExports(read('../src/kernel/in/index.ts'))

describe('@noy-db/hub/in — golden export surface', () => {
  it('value exports match the frozen baseline (runtime enumeration)', () => {
    const runtime = Object.keys(inDoor)
      .filter((k) => (inDoor as Record<string, unknown>)[k] !== undefined)
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
type _FrozenTypes = [Noydb, Vault, Collection<any>, Query<any>, LiveQuery<any>, ChangeEvent]
