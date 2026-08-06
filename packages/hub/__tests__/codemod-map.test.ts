/**
 * The published 0.4.0-pre rename map (#994).
 *
 * The hop from `0.3.0` is ~64 files of mechanical string replacement for a
 * typical consumer, and every one of them writes the same `sed` script
 * independently — getting it subtly wrong, because the tables that drive it are
 * prose. The sharpest trap is documented but not enforceable: `aggregate` has a
 * second, unrelated meaning (derivation rollup aggregates), so a blanket rename
 * corrupts vocabulary that was deliberately left alone. Upstream ran the rename
 * off an explicit identifier map for exactly that reason; this publishes it.
 *
 * `safeGlobalReplace` is the load-bearing field — the difference between a
 * `sed` that works and one that eats unrelated words.
 *
 * These tests exist so the map cannot rot into a second, disagreeing record of
 * the same renames: the subpath rows are checked against the real
 * `package.json` exports, and the option-key rows against the live source.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WRITE_POD_OPTION_KEYS } from '../src/with-pod/bundle.js'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

interface Rename {
  readonly from: string
  readonly to: string | null
  readonly kind: string
  readonly safeGlobalReplace: boolean
  readonly section: string
  /** Qualifies `from` when the same bare name renamed differently per package. */
  readonly package?: string
  readonly note?: string
}

const KINDS = new Set([
  'identifier',
  'type',
  'option-key',
  'subpath',
  'import-move',
  'package',
  'string-literal',
  'wire-path',
  'removed',
])

const map = JSON.parse(read('../codemods/0.4.0-pre.json')) as {
  readonly version: string
  readonly renames: readonly Rename[]
}
const hubPkg = JSON.parse(read('../package.json')) as {
  readonly files: readonly string[]
  readonly exports: Record<string, unknown>
}

describe('0.4.0-pre rename map: shape', () => {
  it('gives every row a kind, a target and a replace-safety verdict', () => {
    for (const r of map.renames) {
      expect(KINDS, `unknown kind on ${r.from}`).toContain(r.kind)
      expect(typeof r.from, `from on ${r.from}`).toBe('string')
      expect(typeof r.safeGlobalReplace, `safeGlobalReplace on ${r.from}`).toBe('boolean')
      expect(r.section, `section on ${r.from}`).toMatch(/^§/)
      if (r.kind === 'removed') expect(r.to, `${r.from} is removed`).toBeNull()
      else expect(typeof r.to, `to on ${r.from}`).toBe('string')
    }
  })

  it('names each identifier once per package', () => {
    // `verify` renamed to two different things — `verifyEmailOtp` and
    // `verifyTotp` — so the key is (package, from), not `from` alone.
    const keys = map.renames.map((r) => `${r.package ?? ''}:${r.from}`)
    expect(keys).toEqual([...new Set(keys)])
  })

  it('explains every row it marks unsafe to replace globally', () => {
    for (const r of map.renames) {
      if (!r.safeGlobalReplace) {
        expect(r.note, `${r.from} is unsafe but unexplained`).toBeTruthy()
      }
    }
  })

  it('keeps the bare `aggregate` word off the safe list', () => {
    const bare = map.renames.find((r) => r.from === 'aggregate')
    expect(bare, 'the documented sharpest trap must be in the map').toBeDefined()
    expect(bare?.safeGlobalReplace).toBe(false)
  })
})

describe('0.4.0-pre rename map: checked against the live surface', () => {
  it('routes subpaths to exports that exist, away from ones that do not', () => {
    const exported = new Set(Object.keys(hubPkg.exports))
    const asKey = (specifier: string) =>
      specifier === '@noy-db/hub' ? '.' : specifier.replace('@noy-db/hub', '.')
    for (const r of map.renames) {
      if (r.kind !== 'subpath') continue
      expect(exported, `${r.from} still resolves`).not.toContain(asKey(r.from))
      // A row may point at more than one landing spot (`/bundle` split in two).
      for (const target of (r.to as string).split(/\s+or\s+/)) {
        expect(exported, `${r.from} → ${target} does not resolve`).toContain(asKey(target))
      }
    }
  })

  it('agrees with the `never` tombstones left on NoydbOptions', () => {
    // Scoped to NoydbOptions — the envelope types carry unrelated `never`
    // props that mark mutually-exclusive union arms.
    const options = /export interface NoydbOptions \{([\s\S]*?)\n\}/.exec(
      read('../src/kernel/types.ts'),
    )?.[1]
    expect(options, 'NoydbOptions interface not found').toBeDefined()
    const tombstones = [
      ...(options as string).matchAll(/^  readonly ([A-Za-z0-9_]+)\?: never$/gm),
    ].map((m) => m[1])
    const mapped = map.renames.filter((r) => r.kind === 'option-key' && r.section === '§5b')
    expect(mapped.map((r) => r.from).sort()).toEqual([...tombstones].sort())
  })

  it('agrees with the retired pod-write options the writer refuses', () => {
    const row = map.renames.find((r) => r.from === 'autoPassphrases')
    expect(row, 'the silently-dropped key must be in the map (#991)').toBeDefined()
    expect(WRITE_POD_OPTION_KEYS as readonly string[]).toContain(row?.to)
  })
})

describe('0.4.0-pre rename map: reachable by consumers', () => {
  it('ships in the package and resolves at the path the map is versioned by', () => {
    expect(hubPkg.files).toContain('codemods')
    // `@noy-db/hub/codemods/<version>.json`. Each release line gets its own
    // explicit entry — every other subpath in this package is explicit too,
    // and a wildcard would defeat the build's exports-resolve check.
    const subpath = `./codemods/${map.version}.json`
    expect(hubPkg.exports, subpath).toHaveProperty(subpath)
    expect(hubPkg.exports[subpath]).toBe(subpath)
  })
})
