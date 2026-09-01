#!/usr/bin/env node
/**
 * check-prose-examples — do our SHIPPED examples actually compile?
 *
 * ## The class this catches
 *
 * `check-prose-api` answers "does this method exist". Every defect found on
 * 2026-08-28 answered that question YES and was still wrong, because the
 * method existed and the ARGUMENT did not:
 *
 *   packages/hub/README.md:60    createNoydb({ userId: 'alice' })   option is `user`
 *   packages/hub/src/index.ts:28 openVault('acme', { secret })      `secret` is a
 *                                                                  createNoydb option
 *   docs/subsystems/*.md         collection.describeAsync({...})    private; the
 *                                                                  public path is
 *                                                                  describe(opts)
 *
 * The first of those shipped in every tarball and is the documented origin of
 * three consumer bug reports filed as hub defects — a reader cannot guess the
 * identity option's name from an example that omits it, and `userId` is the
 * obvious guess. Presence-checking cannot see any of this; a compiler sees all
 * of it. This is the family's "symbol presence vs does the signature accept the
 * argument" proxy, answered the way that table prescribes.
 *
 * ## Why only fenced blocks that IMPORT
 *
 * KNOWN COST (2026-08-29): a Nuxt config block (`defineNuxtConfig({...})`)
 * has no import — the function is a Nuxt auto-global — so it is skipped as
 * illustrative. in-nuxt's `noydb: { adapter: 'browser' }` (wrong key AND a
 * value outside the ModuleOptions union) survived a full sweep this way.
 * Typing such a block would need Nuxt's ambient globals plus the module's
 * NuxtConfig augmentation in the probe; until someone builds that, an
 * import-less config block is checked by NOTHING and its README must be
 * verified against the module's ModuleOptions by hand.
 *
 * Scoped the way check-prose-api was scoped — narrow what a noisy check
 * examines rather than tuning a threshold. A block opening with an import
 * claims to be runnable; a bare fragment is illustrative and is SKIPPED and
 * counted, never silently dropped.
 *
 * ## Which diagnostics count
 *
 * Ignored, because they are properties of the PROBE, not claims about our API:
 *   TS2304  cannot find name        — elided variable in an illustrative snippet
 *   TS2307  cannot find module      — a sibling package that is not built here
 *   TS2552  cannot find name (did you mean) — same class as 2304
 * Everything else is a statement about our own surface and fails the gate.
 *
 * Run: node scripts/check-prose-examples.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, symlinkSync, realpathSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const OUT = join(ROOT, '.prose-examples')
// Ignored because they are properties of the PROBE, not claims about our API.
// An illustrative snippet legitimately elides variables and parameter types;
// it does NOT legitimately name an export or option that does not exist.
const IGNORED = new Set([
  'TS2304',  // cannot find name            — elided variable
  'TS2307',  // cannot find module          — sibling package not built here
  'TS2552',  // cannot find name (did-you-mean form of 2304)
  'TS18004', // no value in scope for shorthand property `{ store, user }`
  'TS18046', // 'x' is of type 'unknown'    — cascade from an elided type
  'TS2834',  // relative import needs extension — the snippet's neighbour file is elided
  'TS2448',  // used before declaration      — prose narrates out of order
  'TS2454',  // used before assigned         — same
])

// ── Sources: prose that ships, plus tracked subsystem docs ────────────────
const files = []
const addIf = (p) => { if (existsSync(p)) files.push(p) }
addIf('README.md')
for (const pkg of readdirSync('packages')) addIf(join('packages', pkg, 'README.md'))
// JSDoc module comments on published entry points ship inside the .d.ts.
addIf('packages/hub/src/index.ts')
// SERVICES.md and docs/subsystems moved to the private family layer
// (2026-08-31 restructure). They are still checked by the SAME machinery via
// PROSE_EXTRA — a comma-separated list of .md files or directories — which the
// private layer's runner sets. Deliberately an EXPLICIT list rather than an
// existsSync probe of ../ paths: a silently-absent directory here would make
// this gate go green while examining nothing, the exact failure its own
// two-pass template exclusion was built to avoid.
for (const extra of (process.env.PROSE_EXTRA ?? '').split(',').filter(Boolean)) {
  if (!existsSync(extra)) { console.error(`PROSE_EXTRA entry does not exist: ${extra}`); process.exit(1) }
  if (statSync(extra).isDirectory()) {
    for (const f of readdirSync(extra)) if (f.endsWith('.md')) files.push(join(extra, f))
  } else files.push(extra)
}

// ── Extract fenced ts blocks, with their 1-based start line ───────────────
const blocks = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const isSource = file.endsWith('.ts')
  // In a .ts file the fences live inside a /** */ block; strip leading ` * `.
  const lines = text.split('\n')
  let open = null, buf = [], fenceLang = ''
  lines.forEach((raw, i) => {
    const line = isSource ? raw.replace(/^\s*\*ic?\s?/, '').replace(/^\s*\*\s?/, '') : raw
    const fence = line.match(/^```(ts|typescript|vue)\s*$/)
    if (fence && open === null) { open = i + 2; buf = []; fenceLang = fence[1]; return }
    if (open !== null && /^```\s*$/.test(line)) {
      let code = buf.join('\n'), lineOff = 0
      if (fenceLang === 'vue') {
        // A ```vue block's checkable half is its <script> content; the
        // template is Vue syntax tsc cannot parse. Extract it, keeping the
        // line offset so diagnostics map back to the right prose line.
        const m = code.match(/<script[^>]*>\n([\s\S]*?)<\/script>/)
        if (m) { lineOff = code.slice(0, m.index).split('\n').length; code = m[1] }
        else code = ''
      }
      if (code.trim() !== '') blocks.push({ file, line: open + lineOff, code })
      open = null; return
    }
    if (open !== null) buf.push(line)
  })
}

const runnable = blocks.filter((b) => /^\s*import\s/m.test(b.code))
const skipped = blocks.length - runnable.length

// ── Probe project ─────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const paths = {}
for (const pkg of readdirSync('packages')) {
  const manifest = join('packages', pkg, 'package.json')
  if (!existsSync(manifest)) continue
  const name = JSON.parse(readFileSync(manifest, 'utf8')).name
  const dts = join(ROOT, 'packages', pkg, 'dist', 'index.d.ts')
  if (name && existsSync(dts)) paths[name] = [dts]
}
// Framework modules (vue, pinia, h3, ...) SYMLINKED into the probe's own
// node_modules from each package's node_modules, so nodenext resolution —
// exports maps included — finds their real types. Without this,
// `import { createApp } from 'vue'` is an IGNORED TS2307, createApp is
// `any`, and `.use(NoydbPlugin, {...})` is an untyped call — the options
// literal is never checked against NoydbPluginOptions. Found 2026-08-29:
// in-vue's README shipped `adapter:`/`userId:` (neither exists on the
// interface) through exactly this laundering — the block WAS extracted and
// WAS compiled, and the two ignore mechanisms composed to make the check
// vacuous. (A `paths` entry cannot do this: its targets are file paths, so
// a directory target never gets package.json/exports resolution.)
const PROBE_NM = join(OUT, 'node_modules')
const linkFramework = (name, target) => {
  const dest = join(PROBE_NM, name)
  if (existsSync(dest)) return
  mkdirSync(join(dest, '..'), { recursive: true })
  try { symlinkSync(target, dest, 'junction') } catch { /* racing duplicate — fine */ }
}
for (const pkg of readdirSync('packages')) {
  const nm = join(ROOT, 'packages', pkg, 'node_modules')
  if (!existsSync(nm)) continue
  for (const e of readdirSync(nm)) {
    if (e.startsWith('.') || e === '@noy-db') continue
    if (e.startsWith('@')) {
      for (const sub of readdirSync(join(nm, e))) linkFramework(`${e}/${sub}`, realpathSync(join(nm, e, sub)))
    } else linkFramework(e, realpathSync(join(nm, e)))
  }
}
if (Object.keys(paths).length === 0) {
  console.error('check-prose-examples: no built dist found — run `pnpm build` first.')
  process.exit(2)
}
// The examples are ESM (top-level await throughout). Without this the probe
// inherits the repo root's CommonJS default and every such block reports
// TS1309 — a MODULE-FORMAT diagnostic that shares the TS1xxx range with real
// parse errors, which silently exempted 74 of 79 blocks on the first build.
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ type: 'module' }))
// Snippets for browser bundlers legitimately assume `import.meta.env`. Model
// the app environment they target rather than weakening API checking.
writeFileSync(join(OUT, 'ambient.d.ts'), 'interface ImportMeta { readonly env: Record<string, string> }\n')
if (process.env.PROSE_DEBUG) { const c={}; for (const b of runnable) c[b.file]=(c[b.file]||0)+1; console.error('RUNNABLE BY FILE:', JSON.stringify(c,null,1)); console.error('PATHS KEYS:', Object.keys(paths).length) }
runnable.forEach((b, i) => { b.probe = `ex${i}.ts`; b.nodeTyped = declaresNodeTypes(b.file); writeFileSync(join(OUT, b.probe), b.code) })
// ── Ambient globals: the package's own declaration decides ────────────────
// `types` is NOT left to default. Defaulting pulls in every @types/* the probe
// host happens to have installed, which makes the gate a test of that host's
// dependency list rather than of our prose.
//
// #1306: setting it to [] repo-wide ALSO removed every ambient global, so a
// package that correctly declares @types/node still could not use `process`
// in a shipped example — two TRUE examples failed TS2591 for a probe reason,
// and the gate sat red across the 0.7.0 cut. That is the recorded shape "an
// ignored diagnostic is scoped to what it names, but its consequence is not":
// the decision was made for module resolution and silently took the globals.
//
// The fix keeps the DECLARATION load-bearing instead of switching Node
// globals on everywhere. Blocks compile in two programs: `types: []` for
// packages that do not declare @types/node, `types: ['node']` for those that
// do. A README using `process` in a package that does not declare it still
// fails — and that is a true finding about the manifest, not probe noise.
// Two programs, not one per package: only a handful of packages declare it.
// (a function declaration, not a const: it is called by the probe-writing
// loop above, which runs before this point in the file.)
function declaresNodeTypes(file) {
  const m = relative(ROOT, file).match(/^packages[/\\]([^/\\]+)[/\\]/)
  const manifest = m ? join(ROOT, 'packages', m[1], 'package.json') : join(ROOT, 'package.json')
  if (!existsSync(manifest)) return false
  const j = JSON.parse(readFileSync(manifest, 'utf8'))
  return Boolean({ ...j.dependencies, ...j.devDependencies, ...j.peerDependencies }['@types/node'])
}

const compile = (exclude) => {
  const ex = new Set(exclude)
  let raw = ''
  for (const [group, types] of [['plain', []], ['node', ['node']]]) {
    const files = runnable
      .filter((b) => b.nodeTyped === (group === 'node') && !ex.has(b.probe))
      .map((b) => b.probe)
    if (files.length === 0) continue
    const cfg = join(OUT, `tsconfig.${group}.json`)
    writeFileSync(cfg, JSON.stringify({
      compilerOptions: {
        module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022',
        strict: true, noImplicitAny: false, noEmit: true, skipLibCheck: true, types, baseUrl: '.', paths,
      },
      files: [...files, 'ambient.d.ts'],
    }, null, 2))
    try { execFileSync('npx', ['tsc', '-p', cfg], { encoding: 'utf8', stdio: 'pipe' }) }
    catch (e) { raw += `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
  return raw
}

const parse = (raw) => {
  const out = []
  for (const line of raw.split('\n')) {
    const m = line.match(/(?:^|[/\\])(ex\d+)\.ts\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.*)$/)
    if (!m) continue
    const [, probe, row, , code, msg] = m
    const b = runnable.find((x) => x.probe === `${probe}.ts`)
    if (b) out.push({ b, line: b.line + Number(row) - 1, code, msg })
  }
  return out
}

// ── Pass 1: find blocks that are not parseable TypeScript ─────────────────
// These are TEMPLATES (`with<Name>`, `store: ...`), not examples. They must be
// EXCLUDED, not merely ignored: tsc reports syntactic diagnostics and then
// SKIPS SEMANTIC CHECKING FOR THE WHOLE PROGRAM, so a single template silences
// the gate for every other block. Measured 2026-08-28: 5 templates suppressed
// type-checking of all 79 blocks and the gate reported "all examples compile".
const unparseable = new Set(parse(compile([])).filter((d) => /^TS1\d{3}$/.test(d.code)).map((d) => d.b))

// ── Pass 2: type-check what is left ───────────────────────────────────────
const failures = parse(compile([...unparseable].map((b) => b.probe)))
  .filter((d) => !IGNORED.has(d.code) && !/^TS1\d{3}$/.test(d.code))
  .map((d) => ({ file: d.b.file, line: d.line, code: d.code, msg: d.msg }))

const BASELINE = join(ROOT, 'scripts', 'prose-examples-baseline.json')

console.log(`check-prose-examples: ${runnable.length} runnable of ${blocks.length} fenced blocks (${skipped} without imports, skipped)`)
if (unparseable.size > 0) {
  console.log(`  ${unparseable.size} template block(s) not parseable as TypeScript — not checked:`)
  for (const b of unparseable) console.log(`    ${relative(ROOT, b.file)}:${b.line}`)
}

// ── Ratchet ───────────────────────────────────────────────────────────────
// Keyed on file+code+message, NOT line, so ordinary prose edits do not churn
// it. It is a ratchet rather than an allowlist because a baseline entry that
// STOPS failing is also an error: the list can only shrink, so it cannot
// quietly become permanent the way a static exemption list does.
const key = (f) => `${relative(ROOT, f.file)} | ${f.code} | ${f.msg}`
const baseline = existsSync(BASELINE) ? new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).known) : new Set()
const seen = new Set(failures.map(key))

if (process.env.PROSE_WRITE_BASELINE) {
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Known-broken shipped examples. Shrink-only: remove an entry when you fix it. Never add.',
    known: [...seen].sort(),
  }, null, 2) + '\n')
  console.log(`  baseline written with ${seen.size} known failure(s)`)
  process.exit(0)
}

const introduced = failures.filter((f) => !baseline.has(key(f)))
const fixed = [...baseline].filter((k) => !seen.has(k))

if (introduced.length === 0 && fixed.length === 0) {
  if (!process.env.PROSE_DEBUG) rmSync(OUT, { recursive: true, force: true })
  console.log(`  no new failures (${baseline.size} known, tracked in ${relative(ROOT, BASELINE)})`)
  process.exit(0)
}
if (introduced.length > 0) {
  console.error(`\n${introduced.length} NEW example(s) do not compile:\n`)
  for (const f of introduced) console.error(`  ${relative(ROOT, f.file)}:${f.line}  ${f.code}  ${f.msg}`)
}
if (fixed.length > 0) {
  console.error(`\n${fixed.length} baseline entr(ies) no longer fail — remove them from ${relative(ROOT, BASELINE)}:\n`)
  for (const k of fixed) console.error(`  ${k}`)
}
console.error(`\nProbe project kept at ${relative(ROOT, OUT)} for inspection.`)
process.exit(1)
