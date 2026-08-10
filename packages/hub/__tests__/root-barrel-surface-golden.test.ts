/**
 * Golden export-surface freeze for the root `@noy-db/hub` barrel (S5 Task 8).
 *
 * `src/index.ts` is the flat public surface every consumer imports from
 * (`import { createNoydb, ... } from '@noy-db/hub'`) — the union of the
 * always-on core plus every opt-in service's exports. This freezes the
 * export list against a checked-in baseline (`root-barrel-surface.golden.json`)
 * so drift fails CI:
 *   - ADDING an export fails until the baseline is updated (visible, reviewed).
 *   - REMOVING / RENAMING an export fails loudly.
 *
 * MECHANISM (mirrors `cargo-surface-golden.test.ts` / `kernel-surface-golden.test.ts`):
 *   1. VALUE exports — enumerated at runtime via `Object.keys(import * as index)`.
 *   2. SOURCE parse — the same runtime list, cross-checked by parsing the
 *      `export { … } from` blocks out of `src/index.ts` directly (unlike
 *      `/cargo`, the root barrel does not `export *` from another module, so
 *      there is no separate "floor" source to union in).
 *   3. TYPE-only exports — same source-parse approach applied to
 *      `export type { … } from` blocks. This baseline is intentionally large
 *      (~430+ values / ~380+ types) — the size isn't the point, the freeze is.
 *
 * EXTENSION over the `/cargo` exemplar: `src/index.ts` has one export block
 * that mixes an inline `type` modifier into an otherwise-value block
 * (`export { fuseRetrieval, type FuseOptions } from …`). The exemplar's
 * regex would misclassify `FuseOptions` as a value named `"type FuseOptions"`,
 * so `parseExports` below additionally splits on a leading `type ` token
 * inside `export { … } from` blocks and routes that part to `types`.
 *
 * This baseline is maintained by future PRs consciously editing it, the same
 * as the `/kernel` and `/cargo` goldens.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as index from '../src/index.js'

interface Surface {
  readonly values: readonly string[]
  readonly types: readonly string[]
  /**
   * Names that USED to be exported from the root barrel and no longer are
   * (#1011). Move an export's name here when you remove it — the codemod-map
   * suite reads this list and requires a migration row for every entry, which
   * is what stops a root-barrel removal from shipping unannounced.
   */
  readonly retired?: readonly string[]
}

function read(url: string): string {
  return readFileSync(fileURLToPath(new URL(url, import.meta.url)), 'utf8')
}

/**
 * Strip comments, then collect names from `export [type] { … } from` blocks.
 * A plain `export { … } from` block may still mix in an inline `type X`
 * named export (e.g. `export { fuseRetrieval, type FuseOptions } from …`) —
 * those parts are routed to `types`, not `values`.
 */
function parseExports(src: string): { values: string[]; types: string[] } {
  const clean = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const resolveName = (part: string): string | undefined =>
    part.trim().split(/\s+as\s+/).pop()?.trim()
  const values = new Set<string>()
  const types = new Set<string>()
  for (const m of clean.matchAll(/export\s+type\s*\{([^}]*)\}\s*from/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const name = resolveName(part)
      if (name) types.add(name)
    }
  }
  for (const m of clean.matchAll(/export\s*\{([^}]*)\}\s*from/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('type ')) {
        const name = resolveName(trimmed.slice('type '.length))
        if (name) types.add(name)
      } else {
        const name = resolveName(trimmed)
        if (name) values.add(name)
      }
    }
  }
  return { values: [...values], types: [...types] }
}

const uniqSort = (xs: string[]): string[] => [...new Set(xs)].sort()

const baseline: Surface = JSON.parse(read('./root-barrel-surface.golden.json')) as Surface
const parsed = parseExports(read('../src/index.ts'))

describe('@noy-db/hub — root barrel golden export surface', () => {
  it('value exports match the frozen baseline (runtime enumeration)', () => {
    const runtime = Object.keys(index)
      .filter((k) => (index as Record<string, unknown>)[k] !== undefined)
      .sort()
    expect(runtime).toEqual([...baseline.values].sort())
  })

  it('value exports in source match the baseline (source parse)', () => {
    expect(uniqSort(parsed.values)).toEqual([...baseline.values].sort())
  })

  // #1011 — the `retired` ledger. Additions to the root barrel were always
  // visible (the baseline had to be edited), but a REMOVAL was equally quiet:
  // you deleted the export, deleted its baseline line, and the suite went
  // green with nothing recording that a public name had vanished. A consumer's
  // only warning was a build error in their own tree.
  //
  // Removing an export now means MOVING its name into `retired`, which the
  // codemod-map suite reads to demand a migration row for it. Two cheap
  // assertions keep the ledger honest.
  it('never lists a retired symbol that is still exported', () => {
    const live = new Set([...baseline.values, ...baseline.types])
    const resurrected = (baseline.retired ?? []).filter((name) => live.has(name))
    expect(resurrected, 'retired symbols must not also be exported').toEqual([])
  })

  it('keeps the retired ledger free of duplicates', () => {
    const retired = baseline.retired ?? []
    expect(retired).toEqual(uniqSort([...retired]))
  })

  it('type exports match the frozen baseline (source parse)', () => {
    expect(uniqSort(parsed.types)).toEqual([...baseline.types].sort())
  })
})
