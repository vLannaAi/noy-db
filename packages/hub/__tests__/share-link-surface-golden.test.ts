/**
 * Golden export-surface freeze for the `@noy-db/hub/share-link` subpath
 * (#806 — the portal share-link grammar).
 *
 * The share-link grammar is a frozen CONTRACT by nature: links are
 * minted into chat messages, QR codes, and bookmarks that outlive any
 * release, and three surfaces (LIFF permalink, PWA, vendor console)
 * parse the same shape. This test freezes the subpath's export list
 * against a checked-in baseline (`share-link-surface.golden.json`) so
 * drift fails CI — adding requires a visible baseline update,
 * removing / renaming fails loudly.
 *
 * MECHANISM — identical to the `/as` and `/to` golden tests (see their
 * headers for the rationale): runtime `Object.keys` freezes the VALUE
 * exports; a source-parse of the `export type { … } from` blocks
 * freezes the TYPE-only exports (erased at runtime); a compile-time
 * `import type` list asserts every baselined type still resolves so a
 * removal also breaks `typecheck`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as shareLink from '../src/share-link/index.js'
import type { ShareLink, ShareLinkParts, ShareLinkErrorCode } from '../src/share-link/index.js'

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

const baseline: Surface = JSON.parse(read('./share-link-surface.golden.json')) as Surface
const parsed = parseExports(read('../src/share-link/index.ts'))

describe('@noy-db/hub/share-link — golden export surface', () => {
  it('value exports match the frozen baseline (runtime enumeration)', () => {
    const runtime = Object.keys(shareLink)
      .filter((k) => (shareLink as Record<string, unknown>)[k] !== undefined)
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
type _FrozenTypes = [ShareLink, ShareLinkParts, ShareLinkErrorCode]
