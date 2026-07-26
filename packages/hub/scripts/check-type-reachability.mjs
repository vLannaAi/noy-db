/**
 * Subpath type-reachability guard (#837).
 *
 * A consumer importing from `@noy-db/hub/<subpath>` must be able to NAME
 * every type that subpath's own functions mention. When a function is
 * exported from `./team` but its options type is only on the root barrel,
 * the consumer has to dual-import — and in the worst case (a type exported
 * from NO entry at all) the type is unspellable and the call cannot be
 * annotated.
 *
 * This drifted invisibly for a long time because exports were curated by
 * hand, per function. #812/#820 were two instances; this script turns the
 * whole class into a build failure.
 *
 * Ground truth is the BUILT `.d.ts` surface — what consumers actually
 * resolve — not the source, so run it after `pnpm build`.
 *
 * Usage:
 *   node scripts/check-type-reachability.mjs           # enforce the baseline
 *   node scripts/check-type-reachability.mjs --report  # print every gap, exit 0
 *   BASELINE_UPDATE=1 node scripts/check-type-reachability.mjs
 */
import ts from 'typescript'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const BASELINE = join(HERE, 'type-reachability.baseline.json')

/** Types that are always spellable: TS intrinsics, lib globals, well-knowns. */
const AMBIENT = new Set([
  'Array', 'ReadonlyArray', 'Promise', 'Record', 'Partial', 'Required', 'Readonly',
  'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Parameters',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error', 'Uint8Array',
  'ArrayBuffer', 'ArrayBufferLike', 'ArrayBufferView', 'DataView', 'Iterable',
  'IterableIterator', 'AsyncIterable', 'AsyncIterableIterator', 'Iterator',
  'Function', 'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'CryptoKey', 'Crypto', 'SubtleCrypto', 'Response', 'Request', 'Headers',
  'Blob', 'File', 'FormData', 'URL', 'URLSearchParams', 'AbortSignal',
  'ReadableStream', 'WritableStream', 'TransformStream', 'EventTarget', 'Event',
  'JSON', 'Math', 'Awaited', 'InstanceType', 'ThisType',
  'ReadonlySet', 'ReadonlyMap', 'PromiseLike', 'ArrayLike', 'Uint32Array',
  'Int32Array', 'Float64Array', 'BufferSource', 'IDBValidKey', 'NodeJS',
])

const pkgJson = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))

/** subpath → absolute .d.ts path, for every entry that resolves to one. */
function entryPoints() {
  const out = new Map()
  for (const [subpath, spec] of Object.entries(pkgJson.exports ?? {})) {
    if (subpath === './package.json') continue
    const types = typeof spec === 'string' ? null : spec.types ?? spec.import?.types
    if (typeof types !== 'string') continue
    const abs = join(PKG, types)
    if (existsSync(abs)) out.set(subpath, abs)
  }
  return out
}

const entries = entryPoints()
if (entries.size === 0) {
  console.error('✗ no resolvable .d.ts entry points — run `pnpm build` first.')
  process.exit(1)
}

const program = ts.createProgram([...entries.values()], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
})
const checker = program.getTypeChecker()

/** Every type name a signature mentions, by walking its AST type nodes. */
function referencedTypeNames(decl) {
  const names = new Set()
  const visit = (node) => {
    if (ts.isTypeReferenceNode(node)) {
      const n = ts.isIdentifier(node.typeName)
        ? node.typeName.text
        : node.typeName.right?.text
      if (n) names.add(n)
    }
    ts.forEachChild(node, visit)
  }
  // Only the signature surface: params + return type, not the whole body.
  if (ts.isFunctionDeclaration(decl) || ts.isMethodSignature(decl) || ts.isMethodDeclaration(decl)) {
    for (const p of decl.parameters) if (p.type) visit(p.type)
    if (decl.type) visit(decl.type)
  } else if (ts.isVariableDeclaration(decl) && decl.type) {
    visit(decl.type)
  }
  return names
}

/** True when `name` is a type parameter of this declaration or an enclosing one. */
function isTypeParamInScope(decl, name) {
  for (let n = decl; n; n = n.parent) {
    const tps = n.typeParameters
    if (tps && tps.some((p) => p.name?.text === name)) return true
  }
  return false
}

/** Resolve an alias symbol, tolerating unresolvable ones. */
function safeAliased(sym) {
  try {
    return checker.getAliasedSymbol(sym) ?? sym
  } catch {
    return sym
  }
}

/** The set of names an entry exports (values and types alike). */
function exportedNames(sourceFile) {
  const sym = checker.getSymbolAtLocation(sourceFile)
  if (!sym) return new Set()
  return new Set(checker.getExportsOfModule(sym).map((s) => s.name))
}

const gaps = []
const skipped = []
for (const [subpath, dts] of entries) {
  const sf = program.getSourceFile(dts)
  if (!sf) { skipped.push(`${subpath} (no source file)`); continue }
  const exported = exportedNames(sf)
  const sym = checker.getSymbolAtLocation(sf)
  if (!sym) { skipped.push(`${subpath} (no module symbol)`); continue }
  for (const exp of checker.getExportsOfModule(sym)) {
    // Most entries re-export, so the symbol here is an ALIAS whose only
    // declaration is the `export { … }` specifier. Follow it to the real
    // declaration, or the signature is never inspected (this is exactly how
    // the guard first under-reported: 5 gaps instead of 30).
    const target = exp.flags & ts.SymbolFlags.Alias ? safeAliased(exp) : exp
    const decls = target.getDeclarations() ?? []
    for (const d of decls) {
      for (const name of referencedTypeNames(d)) {
        if (AMBIENT.has(name)) continue
        if (exported.has(name)) continue
        // Generic type parameters are always spellable at the call site.
        // They can be declared on the node OR on any enclosing declaration
        // (a method on a generic class, a signature inside a generic type).
        if (isTypeParamInScope(d, name)) continue
        // Conventional generic-parameter names. The scope walk above catches
        // most, but a signature reached through an alias can lose its parent
        // chain; `T`, `TRow`, `K`, `V`… are never real exported types here.
        if (/^(T|K|V|U|R|S|E)([A-Z][A-Za-z]*)?$/.test(name)) continue
        gaps.push(`${subpath} :: ${exp.name} mentions ${name}`)
      }
    }
  }
}

const found = [...new Set(gaps)].sort()

// Severity split. A type reachable from SOME entry (usually the root barrel)
// only forces a dual-import — annoying. A type reachable from NO entry is
// UNSPELLABLE: the consumer cannot annotate the call at all. Fix those first.
const everywhere = new Set()
for (const [, dts] of entries) {
  const sf = program.getSourceFile(dts)
  const sym = sf ? checker.getSymbolAtLocation(sf) : undefined
  if (sym) for (const e of checker.getExportsOfModule(sym)) everywhere.add(e.name)
}
const unspellable = [...new Set(found.map((g) => g.split(' mentions ')[1]))]
  .filter((n) => !everywhere.has(n))
  .sort()

// `--counts [name…]` — per-entry export counts, plus membership for any names
// given. Handy when auditing the surface (or checking a claim about it).
if (process.argv.includes('--counts')) {
  const probes = process.argv.slice(process.argv.indexOf('--counts') + 1)
  for (const [subpath, dts] of entries) {
    const sf = program.getSourceFile(dts)
    const sym = sf ? checker.getSymbolAtLocation(sf) : undefined
    const names = sym ? new Set(checker.getExportsOfModule(sym).map((x) => x.name)) : new Set()
    const hits = probes.filter((n) => names.has(n))
    const misses = probes.filter((n) => !names.has(n))
    console.log(
      `${subpath.padEnd(22)} ${String(names.size).padStart(4)} exports` +
        (probes.length ? `  present:[${hits.join(',')}] absent:[${misses.join(',')}]` : ''),
    )
  }
  process.exit(0)
}

if (process.argv.includes('--report')) {
  console.log(`entries: ${entries.size}, analysed: ${entries.size - skipped.length}, skipped: ${skipped.length}`)
  if (skipped.length) console.log('  skipped: ' + skipped.join(', '))
  console.log(`type-reachability: ${found.length} gap(s)`)
  console.log(`UNSPELLABLE (exported from no entry at all): ${unspellable.length}`)
  for (const n of unspellable) console.log('  !! ' + n)
  console.log()
  for (const g of found) console.log('  ' + g)
  process.exit(0)
}

if (process.env.BASELINE_UPDATE === '1') {
  writeFileSync(BASELINE, JSON.stringify({ gaps: found }, null, 2) + '\n')
  console.log(`✓ baseline updated: ${found.length} known gap(s)`)
  process.exit(0)
}

const baseline = existsSync(BASELINE)
  ? new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).gaps)
  : new Set()

const fresh = found.filter((g) => !baseline.has(g))
const fixed = [...baseline].filter((g) => !found.includes(g))

if (fresh.length > 0) {
  console.error(
    `✗ type-reachability: ${fresh.length} NEW gap(s) — a subpath exports a function ` +
      `whose signature names a type that subpath does not export:\n`,
  )
  for (const g of fresh) console.error('  ' + g)
  console.error(
    `\nFix by exporting the type from the same entry (preferred), or — if the gap is ` +
      `genuinely acceptable — record it with BASELINE_UPDATE=1 and say why in the PR.`,
  )
  process.exit(1)
}

console.log(
  `✓ type-reachability OK — ${found.length} known gap(s), 0 new` +
    (fixed.length > 0 ? `; ${fixed.length} fixed (run BASELINE_UPDATE=1 to ratchet)` : ''),
)
