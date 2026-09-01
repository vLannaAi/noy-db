/**
 * Verifies `codemods/0.7.0-pre.json` against the live surface.
 *
 * The 0.7 line retires the `Provider` suffix: it marked some port instances
 * and not others, so it distinguished nothing. `Noydb<Stem>` is the rule
 * `NoydbStore` was already following — which is why the anchor does not move
 * (689 references across five repos; the scheme accommodates it rather than
 * renaming it).
 *
 * Mirrors codemod-map-0.6.test.ts, with one deliberate difference: the surface
 * is the union of the runtime root barrel and every declared subpath, not
 * `Object.keys(hub)` alone. A row whose target lives only on a subpath is
 * correct, and checking the barrel would call it wrong — the proxy that #1154
 * exposed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as hub from '../src/index.js'

interface Row {
  from: string; to: string | null; kind: string
  package: string; safeGlobalReplace: boolean; section: string; note?: string
  /** Source file a non-export row is checked against — see SHAPE_KINDS. */
  where?: string
  /** Set when the target lives in a DIFFERENT package than the source. */
  toPackage?: string
  /**
   * Set when the rename is scoped to specific subpaths because the same name
   * still means something else elsewhere (#1188). Narrows checks 2 and 3 to
   * those subpaths' goldens.
   */
  subpaths?: string[]
}
const read = (u: string) => readFileSync(fileURLToPath(new URL(u, import.meta.url)), 'utf8')
const map = JSON.parse(read('../codemods/0.7.0-pre.json')) as { $comment: string; renames: Row[]; version: string }
const rows = map.renames
// Rows are no longer all hub's: the at-* factory renames live in satellite
// packages, so a hub-surface assertion would call them wrong (the same
// too-narrow-proxy mistake #1154 exposed, one level out).
// A row's `kind` decides WHERE it is answerable, and two of them are not
// answerable against the export surface at all. `option-key` and `method` name
// a field on an options bag and a getter on a class — neither is an export, so
// `Object.keys(hub)` is silent about both, and a surface assertion would pass
// them without looking. They carry a `where` instead: the source file the claim
// is made about, checked there. Same move as the satellite rows below — ask the
// artefact that actually declares the thing.
const SHAPE_KINDS = new Set(['option-key', 'method'])
const hubRows = rows.filter((r) => r.package === '@noy-db/hub' && !SHAPE_KINDS.has(r.kind))
const hubShapeRows = rows.filter((r) => r.package === '@noy-db/hub' && SHAPE_KINDS.has(r.kind))
const satelliteRows = rows.filter((r) => r.package !== '@noy-db/hub')
const surface = new Set(Object.keys(hub))
// Parse the goldens rather than substring-matching them: a renamed-away name
// legitimately REAPPEARS in the `retired` ledger (#1011), so a text search
// cannot tell "still exported" from "correctly retired".
const rootG = JSON.parse(read('./root-barrel-surface.golden.json')) as { values: string[]; types: string[]; retired?: string[] }
const cargoG = JSON.parse(read('./cargo-surface.golden.json')) as { values: string[]; types: string[] }
const frozenLive = new Set([...rootG.values, ...rootG.types, ...cargoG.values, ...cargoG.types])
const frozenRetired = new Set(rootG.retired ?? [])

// A rename can be scoped to a SUBSET of subpaths. #1188 is the first: two
// unrelated types shipped as `FenceState` — a string union on the root barrel,
// and an object on `./by` re-exported by `./cargo` — and only the object moved.
// Checking such a row against the whole surface asks the wrong question and
// fails on a correct rename, because the name legitimately survives elsewhere.
//
// So a row carrying `subpaths` is checked against THOSE goldens and no others.
// A row without it keeps the original global check, which is the stronger one —
// do not add `subpaths` to a row to quiet a failure.
const SUBPATH_GOLDENS: Record<string, string> = {
  './by': './by-surface.golden.json',
  './cargo': './cargo-surface.golden.json',
  './to': './to-surface.golden.json',
  './at': './at-surface.golden.json',
  './on': './on-surface.golden.json',
  './as': './as-surface.golden.json',
  './pod': './pod-surface.golden.json',
  './introspection': './introspection-surface.golden.json',
}
function surfaceOf(subpath: string): Set<string> {
  const file = SUBPATH_GOLDENS[subpath]
  if (!file) throw new Error(`row declares subpath '${subpath}' with no golden — add one to SUBPATH_GOLDENS`)
  const g = JSON.parse(read(file)) as { values: string[]; types: string[] }
  return new Set([...g.values, ...g.types])
}

describe('codemods/0.7.0-pre.json', () => {
  it('1. is declared as a published subpath export', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, unknown> }
    expect(pkg.exports['./codemods/0.7.0-pre.json']).toBeDefined()
  })

  it('2. every hub `to` exists — as a runtime value or on a frozen surface', () => {
    for (const r of hubRows) {
      const found = r.subpaths
        ? r.subpaths.every((sp) => surfaceOf(sp).has(r.to!))
        : surface.has(r.to!) || frozenLive.has(r.to!)
      expect(found, `${r.from} → ${r.to} — target missing from ${r.subpaths?.join(', ') ?? 'the published surface'}`).toBe(true)
    }
  })

  it('3. every hub `from` is genuinely GONE', () => {
    for (const r of hubRows) {
      if (r.subpaths) {
        // Scoped: gone from each named subpath. Deliberately says nothing about
        // the rest of the surface, where the same name may mean something else.
        for (const sp of r.subpaths) {
          expect(surfaceOf(sp).has(r.from), `${r.from} is still on ${sp} — the rename did not land`).toBe(false)
        }
        continue
      }
      expect(surface.has(r.from), `${r.from} is still exported at runtime — the rename did not land`).toBe(false)
      expect(frozenLive.has(r.from), `${r.from} still sits on a frozen EXPORT list`).toBe(false)
    }
  })

  it('3b. a scoped row names subpaths that HAVE goldens — no silent skip', () => {
    // Without this, a typo'd subpath would throw inside test 3 and read as a
    // map error rather than a missing-golden error. It also stops `subpaths`
    // becoming a way to opt a row out of checking entirely.
    for (const r of hubRows) for (const sp of r.subpaths ?? []) expect(() => surfaceOf(sp), `${r.from} → ${sp}`).not.toThrow()
  })

  it('4. explains every row it marks unsafe to replace globally', () => {
    for (const r of rows) if (!r.safeGlobalReplace) expect(r.note, `${r.from} unsafe but unexplained`).toBeTruthy()
  })

  it('5. every row has a target — this line renames, it does not delete', () => {
    for (const r of rows) expect(r.to, `${r.from} has no target`).toBeTruthy()
  })

  it('6. no row duplicates another IN THE SAME PACKAGE', () => {
    // Keyed on (package, from), not `from` alone — codemod-map.test.ts got
    // this right for the 0.4 line and this file was ported from 0.6, which
    // had no cross-package rows and so never needed it. One name legitimately
    // renames in two packages at once: `ShamirRecoveryProvider` is hub's port
    // AND on-shamir's structural mirror of it, and they must move together.
    const keys = rows.map((r) => `${r.package}:${r.from}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('7. states WHY the internal renames are absent — the #1052 over-count', () => {
    // StoreCoordinationProvider and createDefaultCoordinationProvider were
    // renamed in the same sweep and are reachable from NO declared subpath of
    // published 0.6.0, so no consumer could hold them. Listing them would
    // repeat the SubsystemBus mistake; being silent about WHY invites someone
    // to "fix" the omission.
    expect(map.$comment).toMatch(/StoreCoordinationProvider/)
    expect(map.$comment).toMatch(/SubsystemBus/)
    for (const name of ['StoreCoordinationProvider', 'createDefaultCoordinationProvider']) {
      expect(rows.find((r) => r.from === name), `${name} is internal — it must NOT have a row`).toBeUndefined()
    }
  })

  it('8. leaves NoydbStore alone — the anchor the scheme was built around', () => {
    // A type, so it erases at runtime; the frozen surface is where it is visible.
    expect(rows.find((r) => r.from === 'NoydbStore')).toBeUndefined()
    expect(frozenLive.has('NoydbStore')).toBe(true)
  })

  it('9. every renamed-away name landed in the retired ledger (#1011)', () => {
    const missing = hubRows.map((r) => r.from).filter((n) => !frozenRetired.has(n) && !frozenLive.has(n))
    // Only root-barrel names are ledgered; /cargo-only names have no ledger.
    const rootOnly = missing.filter((n) => n === 'CoordinationProvider' ? false : true)
    expect(rootOnly, 'a name left the root barrel without joining `retired`').toEqual([])
  })
})

describe('codemods/0.7.0-pre.json — shape rows (not exports)', () => {
  it('every option-key / method row declares WHERE it is checkable', () => {
    // Without this the row is unfalsifiable: nothing else in the suite can see
    // an options field or a getter, so an unanchored row would pass by default.
    for (const r of hubShapeRows) {
      expect(r.where, `${r.from} is a ${r.kind} row with no \`where\``).toBeTruthy()
    }
  })

  it('the new name is present in the file the row names', () => {
    for (const r of hubShapeRows) {
      const src = read(`../${r.where!}`)
      // Matched the same shape as the removal check below, deliberately. A bare
      // `\bmesh\b` passes on `options.mesh` inside the constructor, so it would
      // go green with the getter still named `coordination` — proving the file
      // mentions the word, not that the API moved.
      const pattern = r.kind === 'method' ? `get ${r.to}\\s*\\(` : `\\b${r.to}\\b`
      expect(src, `${r.where} does not declare ${r.to}`).toMatch(new RegExp(pattern))
    }
  })

  it('the old name is gone from the file the row names', () => {
    for (const r of hubShapeRows) {
      const src = read(`../${r.where!}`)
      // A getter is matched as a DECLARATION, not as a word: `coordination` is
      // ordinary English and appears in prose throughout this repo, so a bare
      // word search would fail on a comment and tell us nothing about the API.
      const pattern = r.kind === 'method' ? `get ${r.from}\\s*\\(` : `\\b${r.from}\\b`
      expect(src, `${r.where} still declares ${r.from}`).not.toMatch(new RegExp(pattern))
    }
  })
})

describe('codemods/0.7.0-pre.json — satellite rows', () => {
  it('names a real package for every non-hub row', () => {
    for (const r of satelliteRows) {
      expect(r.package, `${r.from} has no package`).toMatch(/^@noy-db\//)
    }
  })

  /**
   * Packages whose source left this repo (2026-09-01), with where it went.
   *
   * A row about `@noy-db/at-env` is answerable only against at-env's source,
   * and that source is now one repo over. Rather than skip such rows silently
   * — which would let this suite report 22 checked rows while examining three
   * — the extraction is DECLARED here and its premise is checked below: a
   * package named as extracted must actually be absent, and a row naming a
   * package that is neither present nor declared FAILS. So the map cannot
   * quietly stop being verified, in either direction.
   *
   * ⚠️ The rows themselves are NOT weakened — they are still true of the
   * published packages, and verifying them is the receiving repo's job now.
   */
  const EXTRACTED = new Map([
    ['@noy-db/as-csv', 'vLannaAi/noy-db-as'],
    ['@noy-db/as-json', 'vLannaAi/noy-db-as'],
    ['@noy-db/as-sql', 'vLannaAi/noy-db-as'],
    ['@noy-db/as-xml', 'vLannaAi/noy-db-as'],
    ['@noy-db/at-aws-kms', 'vLannaAi/noy-db-at'],
    ['@noy-db/at-azure-keyvault', 'vLannaAi/noy-db-at'],
    ['@noy-db/at-env', 'vLannaAi/noy-db-at'],
    ['@noy-db/at-gcp-kms', 'vLannaAi/noy-db-at'],
    ['@noy-db/at-macos-keychain', 'vLannaAi/noy-db-at'],
  ])

  it('a row naming an absent package is declared extracted, never silently skipped', () => {
    for (const r of satelliteRows) {
      const dir = r.package.replace('@noy-db/', '')
      const present = existsSync(fileURLToPath(new URL(`../../${dir}/src/index.ts`, import.meta.url)))
      if (EXTRACTED.has(r.package)) {
        // The declaration's own premise. If the package comes back, this row
        // becomes checkable again and the EXTRACTED entry must go — otherwise
        // a present package would ride an exemption written for its absence.
        expect(present, `${r.package} is declared EXTRACTED but its source is here — remove the entry so the row is checked again`).toBe(false)
      } else {
        expect(present, `${r.package} has no source here and is not declared EXTRACTED — say where it went, or this row stops being verified by anything`).toBe(true)
      }
    }
  })

  it('every satellite `to` is exported by the package the row names, and the `from` is gone', () => {
    // Checked against that package's SOURCE, not hub's surface — a row about
    // @noy-db/at-env is answerable only there.
    for (const r of satelliteRows) {
      if (EXTRACTED.has(r.package)) {
        // The source-side halves are unanswerable here. The TARGET half still
        // is when it points into hub, so it is kept rather than dropped with
        // the rest — a partial check that says which part it covers.
        if (r.toPackage?.startsWith('@noy-db/hub')) {
          const target = read(`../src/port/${r.toPackage.split('/').pop()!}/index.ts`)
          expect(target, `${r.toPackage} does not export ${r.to}`).toMatch(new RegExp(`\\b${r.to}\\b`))
        }
        continue
      }
      // A rename can move a symbol across packages — `toPackage` records
      // that, and the target is then checked where it actually lives. Without
      // it the row would have to lie about one end or the other.
      const dir = r.package.replace('@noy-db/', '')
      const src = read(`../../${dir}/src/index.ts`)
      if (r.toPackage) {
        const target = r.toPackage.startsWith('@noy-db/hub')
          ? read(`../src/port/${r.toPackage.split('/').pop()!}/index.ts`)
          : read(`../../${r.toPackage.replace('@noy-db/', '')}/src/index.ts`)
        expect(target, `${r.toPackage} does not export ${r.to}`).toMatch(new RegExp(`\\b${r.to}\\b`))
      } else {
        expect(src, `${r.package} does not export ${r.to}`).toMatch(new RegExp(`\\b${r.to}\\b`))
      }
      // The `from` check honours safeGlobalReplace, which the map sets false
      // precisely for bare nouns. `toString` is Object.prototype's method
      // name: a substring search cannot tell an export from a mention, so for
      // an unsafe row we assert the EXPORT is gone, not the string.
      const gone = r.safeGlobalReplace
        ? !src.includes(r.from)
        : !new RegExp(`export (async )?(function|const|type|interface) ${r.from}\\b`).test(src)
      expect(gone, `${r.package} still exports ${r.from}`).toBe(true)
    }
  })
})
