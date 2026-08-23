/**
 * Golden export-surface freeze for the `@noy-db/hub/on` seam.
 *
 * `/on` carries the unlock contracts, and deliberately more than one kind:
 * `NoydbShamir` is a port instance hub INJECTS, `SlotRewrapCeremony` is a
 * callback hub INVOKES. Freezing matters because the five ceremony types were
 * previously scattered — three on `/team`, two reachable only from the whole
 * root barrel — and a silent removal would send a third-party unlock method
 * back to importing all of `@noy-db/hub` to name one signature.
 *
 * MECHANISM — identical to `to-surface-golden.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  EnclaveKey,
  EnrollAuthenticatorOptions,
  KeyringAuthenticator,
  NoydbShamir,
  SlotRewrapCeremony,
  SlotRewrapContext,
  UnlockedKeyring,
} from '../src/port/on/index.js'

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

const baseline: Surface = JSON.parse(read('./on-surface.golden.json')) as Surface
const parsed = parseExports(read('../src/port/on/index.ts'))

describe('@noy-db/hub/on — golden export surface', () => {
  it('type exports match the frozen baseline (source parse)', () => {
    expect(parsed.types).toEqual([...baseline.types].sort())
  })

  it('value exports match the frozen baseline (source parse)', () => {
    expect(parsed.values).toEqual([...baseline.values].sort())
  })

  it('carries BOTH kinds of unlock contract, not one', () => {
    // The family is not uniform and this seam does not pretend it is. If
    // either disappears, the surface stopped describing what on-* actually
    // does — which is the thing the 0.4 prune got right and the docs got
    // wrong.
    expect(baseline.types, 'the injected port instance').toContain('NoydbShamir')
    expect(baseline.types, 'the callback hub invokes').toContain('SlotRewrapCeremony')
  })
})

type _FrozenTypes = [
  EnclaveKey,
  EnrollAuthenticatorOptions,
  KeyringAuthenticator,
  NoydbShamir,
  SlotRewrapCeremony,
  SlotRewrapContext,
  UnlockedKeyring,
]
