/**
 * Golden export-surface freeze for the `@noy-db/hub/at` seam.
 *
 * `/at` is what the five `at-*` sealing-key providers bind — `at-env`,
 * `at-aws-kms`, `at-gcp-kms`, `at-macos-keychain`, `at-azure-keyvault` — plus
 * `@noy-db/test-sealer-conformance`, which publishes the `NoydbSealer`
 * contract as an executable suite. Seven in-repo binders, and third-party
 * providers are the point of the seam existing at all.
 *
 * `MemorySealer` is on this surface deliberately: it is the double an
 * implementor develops against, and the reason the sealer kit can be
 * smoke-tested in-repo where the mesh kit cannot (see `port/by/index.ts`).
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
import * as port from '../src/port/at/index.js'
import type {
  NoydbSealer,
  RecipientHint,
  RecipientSealer,
  SealedEnvelope,
  SealedSecret,
} from '../src/port/at/index.js'

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
const parsed = parseExports(read('../src/port/at/index.ts'))

describe('@noy-db/hub/at — golden export surface', () => {
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
  NoydbSealer,
  RecipientHint,
  RecipientSealer,
  SealedEnvelope,
  SealedSecret,
]
