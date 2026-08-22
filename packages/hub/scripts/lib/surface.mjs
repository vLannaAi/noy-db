/**
 * THE published surface of `@noy-db/hub`, computed once and shared.
 *
 * Two guards need the same answer to the same question — *what can a consumer
 * actually name?* — and two implementations of that would drift:
 *
 *   check-type-reachability.mjs   can a subpath's own signatures be spelled
 *   check-codemod-coverage.mjs    did a symbol leave the surface unmapped
 *
 * Ground truth is the BUILT `.d.ts` surface via the TypeScript checker, not a
 * scan of `dist`. The difference is not cosmetic: a regex over every `.d.ts`
 * reports 1707 symbols for published 0.3.0 where 1143 are reachable, and the
 * surplus is module-internal names no consumer could hold — the same
 * over-count that made #1052's prose table wrong about `SubsystemBus`.
 * `checker.getExportsOfModule` follows alias and re-export chains that a
 * regex cannot.
 */
import ts from 'typescript'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Declared subpath → its built `.d.ts` entry, for entries that resolve. */
export function entryPoints(pkgDir, pkgJson) {
  const pkg = pkgJson ?? JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const out = new Map()
  for (const [subpath, spec] of Object.entries(pkg.exports ?? {})) {
    if (subpath === './package.json') continue
    const types = typeof spec === 'string' ? null : spec.types ?? spec.import?.types
    if (typeof types !== 'string') continue
    const abs = join(pkgDir, types)
    if (existsSync(abs)) out.set(subpath, abs)
  }
  return out
}

/** A program over every entry point, plus its checker. */
export function surfaceProgram(entries) {
  const program = ts.createProgram([...entries.values()], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  })
  return { program, checker: program.getTypeChecker() }
}

/**
 * Every symbol nameable through a declared subpath, and which subpath exposes
 * it. `all` is the union — the set a codemod map is answerable to.
 */
export function reachableExports(pkgDir) {
  const entries = entryPoints(pkgDir)
  if (entries.size === 0) {
    throw new Error(`no resolvable .d.ts entry points under ${pkgDir} — run \`pnpm build\` first`)
  }
  const { program, checker } = surfaceProgram(entries)
  const bySubpath = new Map()
  const all = new Set()
  for (const [subpath, dts] of entries) {
    const sf = program.getSourceFile(dts)
    const sym = sf && checker.getSymbolAtLocation(sf)
    if (!sym) continue
    const names = new Set(checker.getExportsOfModule(sym).map((s) => s.name))
    bySubpath.set(subpath, names)
    for (const n of names) all.add(n)
  }
  return { all, bySubpath }
}
