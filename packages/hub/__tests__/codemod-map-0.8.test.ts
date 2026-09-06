/**
 * `codemods/0.8.0-pre.json` — the query-tiers migration map (#1458).
 *
 * The 0.4/0.6/0.7 maps validate RENAMES: every `to` exists, every `from` is
 * gone. This map carries no renames — nothing changed its name. Every row is
 * an `import-move`: the same symbol, published from a different subpath. So
 * the assertions are different, and both halves have to be checked or a row
 * can point anywhere:
 *
 *   - the `from` subpath must NO LONGER export the symbol, and
 *   - the `to` subpath must export it now.
 *
 * ⛔ A row whose `from` still resolves is not a harmless stale row — it says
 * "you must edit this import" about an import that still works, which is how a
 * migration guide loses the reader's trust for the rows that are real.
 *
 * ⚠️ Checked against SOURCE barrels, not `dist`: the map must be right in the
 * commit that lands it, and `dist` is a build artefact this suite does not
 * require. `check-codemod-coverage.mjs` is the dist-facing guard, and it is
 * blind to this particular break — see the map's own `$comment`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

interface Row {
  readonly from: string
  readonly to: string
  readonly kind: string
  readonly safeGlobalReplace: boolean
  readonly section: string
}

const map = JSON.parse(read('../codemods/0.8.0-pre.json')) as {
  readonly version: string
  readonly renames: readonly Row[]
  readonly sideEffectImports: readonly { subpath: string; methods: readonly string[] }[]
}

const hubPkg = JSON.parse(read('../package.json')) as { readonly exports: Record<string, unknown> }

/** `@noy-db/hub/query/relate` → the source barrel that implements it. */
const SOURCE_BARREL: Record<string, string> = {
  '@noy-db/hub/query': '../src/kernel/query/index.ts',
  '@noy-db/hub/query/live': '../src/kernel/query/live/index.ts',
  '@noy-db/hub/query/reduce': '../src/kernel/query/reduce/index.ts',
  '@noy-db/hub/query/relate': '../src/kernel/query/relate/index.ts',
}

/** Every name a barrel exports, from its `export { … } from` / `export type { … }` lists. */
function exportedNames(barrelPath: string): Set<string> {
  const src = read(barrelPath)
  const names = new Set<string>()
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of (m[1] as string).split(',')) {
      const name = raw.replace(/\btype\b/, '').trim().split(/\s+as\s+/).pop()?.trim() ?? ''
      if (name) names.add(name)
    }
  }
  return names
}

const split = (ref: string): [string, string] => {
  const at = ref.lastIndexOf(':')
  return [ref.slice(0, at), ref.slice(at + 1)]
}

describe('0.8.0-pre query-tiers map: shape', () => {
  it('is entirely import-moves — no row claims a rename', () => {
    expect(map.renames.length).toBeGreaterThan(0)
    for (const r of map.renames) {
      expect(r.kind, `${r.from}`).toBe('import-move')
      expect(r.section, `${r.from}`).toBe('query-tiers')
      // The NAME is unchanged, so a global replace on it is meaningless —
      // the edit is to the specifier, in `/query`-importing files only.
      expect(r.safeGlobalReplace, `${r.from}`).toBe(false)
      const [, fromName] = split(r.from)
      const [, toName] = split(r.to)
      expect(toName, `${r.from} renames as well as moves`).toBe(fromName)
    }
  })
})

describe('0.8.0-pre query-tiers map: checked against the live barrels', () => {
  it('every `from` subpath has genuinely stopped exporting the symbol', () => {
    for (const r of map.renames) {
      const [subpath, name] = split(r.from)
      const barrel = SOURCE_BARREL[subpath]
      expect(barrel, `unknown subpath ${subpath}`).toBeDefined()
      expect(exportedNames(barrel as string), `${r.from} still resolves — the row is a lie`).not.toContain(name)
    }
  })

  it('every `to` subpath exports the symbol, and is a declared export', () => {
    const declared = new Set(Object.keys(hubPkg.exports))
    for (const r of map.renames) {
      const [subpath, name] = split(r.to)
      expect(declared, `${subpath} is not in package.json exports`).toContain(subpath.replace('@noy-db/hub', '.'))
      expect(exportedNames(SOURCE_BARREL[subpath] as string), `${r.to} does not resolve`).toContain(name)
    }
  })

  it('every side-effect subpath resolves and actually installs its methods', () => {
    for (const entry of map.sideEffectImports) {
      const barrel = SOURCE_BARREL[entry.subpath]
      expect(barrel, `unknown subpath ${entry.subpath}`).toBeDefined()
      const src = read(barrel as string)
      // ⭐ TWO FILES, because the install is deliberately split across two.
      // The barrel must CALL its group's installer as a top-level statement —
      // that statement is the only thing keeping the built entry from
      // dissolving into chunks a bundler will drop (see
      // `src/kernel/query/relate/install.ts`) — and the installer must
      // actually patch a prototype. A barrel that kept the call while the
      // installer stopped installing still typechecks, still exports every
      // free function, and throws on every listed method at runtime.
      const group = entry.subpath.split('/').pop() as string
      const installer = `install${group[0]?.toUpperCase() ?? ''}${group.slice(1)}`
      expect(src, `${entry.subpath} does not call ${installer}() at module scope`)
        .toMatch(new RegExp(`^${installer}\\(\\)$`, 'm'))
      expect(src, `${entry.subpath} augments no type`).toMatch(/declare module/)
      const installSrc = read((barrel as string).replace(/index\.ts$/, 'install.ts'))
      expect(installSrc, `${entry.subpath}'s installer patches no prototype`).toMatch(/installMethods\(/)
      expect(entry.methods.length).toBeGreaterThan(0)
    }
  })

  it('names all three groups, so a consumer cannot be told about only two', () => {
    expect(map.sideEffectImports.map((e) => e.subpath).sort()).toEqual([
      '@noy-db/hub/query/live',
      '@noy-db/hub/query/reduce',
      '@noy-db/hub/query/relate',
    ])
  })
})
