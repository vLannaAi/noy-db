/**
 * Golden export-surface freeze for the `@noy-db/hub/as` seam.
 *
 * `/as` is what a format binds — and unlike the 0.3.0 version that was pruned
 * for zero importers, it carries types that exist NOWHERE else. `ImportPolicy`
 * was declared SIX times across `as-*` packages and not at all in hub;
 * `ImportPlan` was declared per package around a hub-owned `VaultDiff`, so an
 * import plan was half hub-owned and half copy-pasted.
 *
 * Freezing it matters more here than for `/to` or `/at`, because those
 * consolidated types have six former homes that could quietly grow back. A
 * silent removal here would send a package straight back to redeclaring one.
 *
 * MECHANISM — identical to `to-surface-golden.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  DecodedChunk,
  ExportChunk,
  ExportFormat,
  FormatExportOptions,
  FormatImportOptions,
  FormatsStrategy,
  ImportPlan,
  ImportPolicy,
  NoydbFormat,
  VaultDiff,
} from '../src/port/as/index.js'

interface Surface { readonly values: readonly string[]; readonly types: readonly string[] }
const read = (u: string): string => readFileSync(fileURLToPath(new URL(u, import.meta.url)), 'utf8')

function parseExports(src: string): { values: string[]; types: string[] } {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
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

const baseline: Surface = JSON.parse(read('./as-surface.golden.json')) as Surface
const parsed = parseExports(read('../src/port/as/index.ts'))

describe('@noy-db/hub/as — golden export surface', () => {
  it('type exports match the frozen baseline (source parse)', () => {
    expect(parsed.types).toEqual([...baseline.types].sort())
  })

  it('value exports match the frozen baseline (source parse)', () => {
    expect(parsed.values).toEqual([...baseline.values].sort())
  })

  it('carries the types that exist nowhere else', () => {
    // Named explicitly rather than left to the count. These are the six-copy
    // consolidation; if one leaves this surface, a package goes back to
    // declaring it locally and nothing would compare the copies again.
    for (const t of ['ImportPolicy', 'ImportPlan', 'NoydbFormat']) {
      expect(baseline.types, `${t} is load-bearing for the as-* family`).toContain(t)
    }
  })
})

type _FrozenTypes = [
  DecodedChunk,
  ExportChunk,
  ExportFormat,
  FormatExportOptions,
  FormatImportOptions,
  FormatsStrategy,
  ImportPlan,
  ImportPolicy,
  NoydbFormat,
  VaultDiff,
]
