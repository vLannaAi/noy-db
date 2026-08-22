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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as hub from '../src/index.js'

interface Row {
  from: string; to: string | null; kind: string
  package: string; safeGlobalReplace: boolean; section: string; note?: string
  /** Source file a non-export row is checked against — see SHAPE_KINDS. */
  where?: string
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

describe('codemods/0.7.0-pre.json', () => {
  it('1. is declared as a published subpath export', () => {
    const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, unknown> }
    expect(pkg.exports['./codemods/0.7.0-pre.json']).toBeDefined()
  })

  it('2. every hub `to` exists — as a runtime value or on a frozen surface', () => {
    for (const r of hubRows) {
      const found = surface.has(r.to!) || frozenLive.has(r.to!)
      expect(found, `${r.from} → ${r.to} — target is nowhere on the published surface`).toBe(true)
    }
  })

  it('3. every hub `from` is genuinely GONE', () => {
    for (const r of hubRows) {
      expect(surface.has(r.from), `${r.from} is still exported at runtime — the rename did not land`).toBe(false)
      expect(frozenLive.has(r.from), `${r.from} still sits on a frozen EXPORT list`).toBe(false)
    }
  })

  it('4. explains every row it marks unsafe to replace globally', () => {
    for (const r of rows) if (!r.safeGlobalReplace) expect(r.note, `${r.from} unsafe but unexplained`).toBeTruthy()
  })

  it('5. every row has a target — this line renames, it does not delete', () => {
    for (const r of rows) expect(r.to, `${r.from} has no target`).toBeTruthy()
  })

  it('6. no row duplicates another', () => {
    const froms = rows.map((r) => r.from)
    expect(new Set(froms).size).toBe(froms.length)
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

  it('every satellite `to` is exported by the package the row names, and the `from` is gone', () => {
    // Checked against that package's SOURCE, not hub's surface — a row about
    // @noy-db/at-env is answerable only there.
    for (const r of satelliteRows) {
      const dir = r.package.replace('@noy-db/', '')
      const src = read(`../../${dir}/src/index.ts`)
      expect(src, `${r.package} does not export ${r.to}`).toMatch(new RegExp(`\\b${r.to}\\b`))
      expect(src.includes(r.from), `${r.package} still exports ${r.from}`).toBe(false)
    }
  })
})
