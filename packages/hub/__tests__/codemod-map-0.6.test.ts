/**
 * Verifies `codemods/0.6.0-pre.json` against the live surface.
 *
 * The map is shipped as a real subpath export — the renames travel as *data*,
 * not just prose in a changelog — so a consumer can run it mechanically. That
 * only holds if every row is true, which is what this pins.
 *
 * #1061 is the reason it exists: `hasNoydbBundleMagic` was removed in the same
 * sweep as the other 17 but missed from the prose table, so the derived
 * migration list handed to downstream repos was one row short. klum-db found it
 * by building — the compiler's "Did you mean 'hasNoydbPodMagic'?" is what named
 * it. A list is a convenience; the build is the check. These tests make the
 * list checkable too.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as hub from '../src/index.js'
import { reachableExports } from '../scripts/lib/surface.mjs'

interface Row {
  from: string
  to: string | null
  kind: string
  package: string
  safeGlobalReplace: boolean
  section: string
  note?: string
}

const map = JSON.parse(
  readFileSync(fileURLToPath(new URL('../codemods/0.6.0-pre.json', import.meta.url)), 'utf8'),
) as { $comment: string; renames: Row[]; version: string }

const rows = map.renames
const hubRows = rows.filter(r => r.package === '@noy-db/hub')

// The ROOT BARREL is not the consumer surface — it is a proxy for it, and the
// proxy is too narrow. `encodePodHeader` / `validatePodHeaderFields` are
// exported from `@noy-db/hub/pod` and never re-homed on the root, so a row
// naming them looked wrong while being right (#1154). What a consumer can
// actually import is every subpath declared in `exports`, which is what
// `reachableExports` walks. Runtime keys still count — they prove the value
// exists rather than only its declaration.
const reachable = reachableExports(fileURLToPath(new URL('..', import.meta.url))).all
const surface = new Set([...Object.keys(hub), ...reachable])

// Types erase at runtime, so they cannot be enumerated off the barrel — the
// root-barrel surface golden covers those. Here we check what is reachable.
const valueRows = hubRows.filter(r => r.kind === 'identifier' && r.to !== null)

describe('codemods/0.6.0-pre.json', () => {
  it('1. is declared as a published subpath export', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { exports: Record<string, unknown> }
    expect(pkg.exports['./codemods/0.6.0-pre.json']).toBeDefined()
  })

  it('2. every `to` identifier actually exists on the hub surface', () => {
    for (const r of valueRows) {
      expect(surface.has(r.to!), `${r.from} → ${r.to} — target missing from @noy-db/hub`).toBe(true)
    }
  })

  it('2b. every `to` METHOD exists on the frozen Vault surface', () => {
    // Methods live on a class instance, so `Object.keys(hub)` cannot see them.
    // The kernel-api golden freezes exactly these surfaces, so check there.
    const golden = readFileSync(
      fileURLToPath(new URL('./kernel-api.golden.json', import.meta.url)), 'utf8')
    for (const r of rows.filter(x => x.kind === 'method' && x.to !== null)) {
      expect(golden, `${r.from} → ${r.to} — not on the frozen Vault/Noydb surface`)
        .toContain(`"${r.to}"`)
    }
  })

  it('3. every `from` is genuinely GONE — no row describes a rename that never happened', () => {
    for (const r of hubRows) {
      // `rotateKeys` is an option key, and the standalone rotateKeys() function
      // still exists — the removed thing is the RevokeOptions field.
      if (r.kind === 'removed' || r.kind === 'method') continue
      expect(surface.has(r.from), `${r.from} is still exported (root barrel or any subpath) — the row is wrong or the removal did not land`).toBe(false)
    }
  })

  it('4. explains every row it marks unsafe to replace globally', () => {
    for (const r of rows) {
      if (!r.safeGlobalReplace) {
        expect(r.note, `"${r.from}" is unsafe to replace globally but carries no note`).toBeTruthy()
      }
    }
  })

  it('5. a `removed` row has no replacement, and every other row has one', () => {
    for (const r of rows) {
      if (r.kind === 'removed') expect(r.to).toBeNull()
      else expect(r.to, `${r.from} has no target`).toBeTruthy()
    }
  })

  it('6. carries the row #1052 missed (#1061)', () => {
    const r = rows.find(x => x.from === 'hasNoydbBundleMagic')
    expect(r, 'hasNoydbBundleMagic must be in the map — its absence is what #1061 reported').toBeDefined()
    expect(r!.to).toBe('hasNoydbPodMagic')
  })

  it('7. states that the wire format did not change', () => {
    // Renaming NOYDB_BUNDLE_MAGIC reads as a format break unless said otherwise.
    expect(map.$comment).toMatch(/NDB1/)
    expect(hub.NOYDB_POD_MAGIC).toEqual(new Uint8Array([0x4e, 0x44, 0x42, 0x31]))
  })

  it('8. no row duplicates another', () => {
    const seen = rows.map(r => r.from)
    expect(new Set(seen).size).toBe(seen.length)
  })
})
