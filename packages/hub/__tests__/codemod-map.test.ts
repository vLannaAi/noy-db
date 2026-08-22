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
import { WRITE_POD_OPTION_KEYS } from '../src/with-pod/pod.js'

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

/** Subpaths a LATER line re-introduced, declared in that line's own map. */
const unretired = new Set<string>(
  ['../codemods/0.6.0-pre.json', '../codemods/0.7.0-pre.json']
    .flatMap((f) => (JSON.parse(read(f)) as { unretired?: string[] }).unretired ?? []),
)

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
    // A LATER line may re-introduce a subpath this one retired — `/at` does,
    // once the port behind it became worth binding. That has to be declared
    // as data rather than assumed from the fact that it resolves, or the
    // guard silently stops guarding the day someone re-adds a retired path by
    // accident. The `unretired` claim is verified separately below.
    for (const r of map.renames) {
      if (r.kind !== 'subpath') continue
      if (unretired.has(r.from)) continue
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

/**
 * #1011 — the gap behind the missing `sum` / `count` rows.
 *
 * The existing checks validate the rows the map DOES carry: subpaths against
 * the real `exports`, option keys against the live source. Nothing asserted the
 * other direction — that a symbol which LEFT the root barrel has a row at all.
 * So the map could silently stop being a complete sweep, and a consumer running
 * it got a clean result that meant nothing. That is worse than no map, because
 * a clean sweep reads as "nothing to migrate".
 *
 * The root-barrel golden's `retired` ledger is the input: removing an export
 * means moving its name there, and every name there must be migratable.
 */
describe('0.4.0-pre rename map: every retired root-barrel symbol is migratable', () => {
  const golden = JSON.parse(read('./root-barrel-surface.golden.json')) as {
    values: string[]
    types: string[]
    retired?: string[]
  }

  it('has a row for every symbol retired from the root barrel', () => {
    // Reads EVERY shipped map, not just this file's. `retired` is a ledger of
    // what left the barrel across the project's whole history, so scoping the
    // lookup to one line would fail the moment a later line retires anything —
    // which is exactly what the 0.7 vocabulary rename does.
    const documented = new Set(
      [map, JSON.parse(read('../codemods/0.6.0-pre.json')), JSON.parse(read('../codemods/0.7.0-pre.json'))]
        .flatMap((m: { renames: Array<{ from: string }> }) => m.renames.map((r) => r.from)),
    )
    const undocumented = (golden.retired ?? []).filter((name) => !documented.has(name))
    expect(
      undocumented,
      'each of these left the root barrel with no codemod row — a consumer running the ' +
        'map-driven sweep would get a clean result and a broken import',
    ).toEqual([])
  })

  // NOTE — the converse check ("no row claims to move a symbol that never
  // left") is deliberately absent, because the map cannot express it. A row
  // records `from` (an identifier) and `to` (a destination path) but NOT the
  // path the symbol moved FROM, so `SyncEngine → @noy-db/hub/sync` is
  // indistinguishable from a stale row even though it is correct: it describes
  // `@noy-db/hub/team` dropping its re-export, while the root barrel still
  // exports the name. Adding a `fromPath` to the row schema would make that
  // check possible; until then asserting it produces false positives.

  it('marks the reducer moves unsafe to replace globally — they are ordinary English', () => {
    // `sum`, `count`, `min`, `max`, `avg` match prose and unrelated identifiers
    // everywhere. This is the same trap the `aggregate` row exists to flag.
    for (const name of ['sum', 'count', 'avg', 'min', 'max']) {
      const row = map.renames.find((r) => r.from === name)
      expect(row, `expected a row for "${name}"`).toBeDefined()
      expect(row!.safeGlobalReplace, `"${name}" must not be globally replaceable`).toBe(false)
    }
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

describe('un-retired subpaths: a claim, not a licence', () => {
  it('every subpath declared `unretired` actually resolves', () => {
    // Without this, `unretired` would be a way to switch the retired-subpath
    // guard off for a path nobody shipped — the guard neutralised by the very
    // field that documents the exception.
    const exported = new Set(Object.keys(hubPkg.exports))
    for (const specifier of unretired) {
      const key = specifier.replace('@noy-db/hub', '.')
      expect(exported, `${specifier} is declared unretired but does not resolve`).toContain(key)
    }
  })

  it('only re-introduces a subpath some earlier line actually retired', () => {
    // Listing a path that was never retired means the field is being used for
    // something other than what it says.
    const retiredEver = new Set(
      map.renames.filter((r) => r.kind === 'subpath').map((r) => r.from),
    )
    for (const specifier of unretired) {
      expect(retiredEver, `${specifier} is declared unretired but was never retired`).toContain(specifier)
    }
  })
})
