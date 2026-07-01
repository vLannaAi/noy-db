/**
 * Golden export-surface freeze for the `@noy-db/hub/pod` seam (lexicon).
 *
 * `/pod` is the canonical vault-serialization artifact seam (`writePod`/
 * `readPod`/`readPodHeader`); `/bundle` remains as a deprecated alias. Like
 * the `/cargo` golden, this freezes the export list against a checked-in
 * baseline (`pod-surface.golden.json`) so drift fails CI:
 *   - ADDING an export fails until the baseline is updated (visible, reviewed).
 *   - REMOVING / RENAMING an export fails loudly.
 *
 * MECHANISM (mirrors `cargo-surface-golden.test.ts`, minus the kernel `export *`
 * floor — `/pod` re-exports named symbols only, so no source union is needed):
 *   1. VALUE exports — enumerated at runtime via `Object.keys(import * as pod)`.
 *   2. SOURCE parse — names collected from the `export [type] { … } from` blocks.
 *   3. TYPE-only exports — same parse; a compile-time `import type` list
 *      additionally asserts every baselined type still resolves, so a
 *      removal/rename also breaks `typecheck`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as pod from '../src/pod/index.js'
import type {
  CompressionAlgo, NoydbBundleHeader, PodReadResult, ReadPodOptions, WritePodOptions,
} from '../src/pod/index.js'

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
    return [...out]
  }
  return {
    types: collect(/export\s+type\s*\{([^}]*)\}\s*from/g),
    values: collect(/export\s*\{([^}]*)\}\s*from/g),
  }
}

const uniqSort = (xs: string[]): string[] => [...new Set(xs)].sort()

const baseline: Surface = JSON.parse(read('./pod-surface.golden.json')) as Surface
const podSrc = parseExports(read('../src/pod/index.ts'))
const parsed = {
  values: uniqSort(podSrc.values),
  types: uniqSort(podSrc.types),
}

describe('@noy-db/hub/pod — golden export surface', () => {
  it('value exports match the frozen baseline (runtime enumeration)', () => {
    const runtime = Object.keys(pod)
      .filter((k) => (pod as Record<string, unknown>)[k] !== undefined)
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
  CompressionAlgo, NoydbBundleHeader, PodReadResult, ReadPodOptions, WritePodOptions,
]
