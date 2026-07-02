/**
 * Golden export-surface freeze for the `@noy-db/hub/at` seam (S5 family doors).
 *
 * A sealing-key provider (`at-env`, `at-aws-kms`, `at-gcp-kms`, …) binds
 * ONLY to this subpath: the `SealingKeyProvider` contract concrete
 * providers implement to seal/unseal a hub-generated random passphrase for
 * managed-passphrase mode. This test freezes its export list against a
 * checked-in baseline (`at-surface.golden.json`) so drift fails CI — adding
 * requires a visible baseline update, removing / renaming fails loudly.
 *
 * MECHANISM — identical to the `/to` golden test (see its header for the
 * rationale). `/at` is type-only (`SealingKeyProvider`'s methods close
 * over only `Uint8Array`/`Promise`/`string`), so the runtime VALUE
 * enumeration is expected to be empty; the source-parse of the
 * `export type { … } from` blocks freezes the TYPE-only exports, and a
 * compile-time `import type` list asserts every baselined type still
 * resolves so a removal also breaks `typecheck`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as at from '../src/kernel/at/index.js'
import type { SealingKeyProvider } from '../src/kernel/at/index.js'

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

const baseline: Surface = JSON.parse(read('./at-surface.golden.json')) as Surface
const parsed = parseExports(read('../src/kernel/at/index.ts'))

describe('@noy-db/hub/at — golden export surface', () => {
  it('value exports match the frozen baseline (runtime enumeration)', () => {
    const runtime = Object.keys(at)
      .filter((k) => (at as Record<string, unknown>)[k] !== undefined)
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
type _FrozenTypes = [SealingKeyProvider]
