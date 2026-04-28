#!/usr/bin/env node
/**
 * Validates `features.yaml` — the spec-to-artefact registry that maps
 * every feature to its spec doc, package, factory, showcases, recipes,
 * playground pages, and diagrams. Run via `pnpm validate:features`.
 *
 * Phase 1 checks:
 *   1. Schema     — required fields, types, no unknown fields.
 *   2. Path round-trip — every file path field resolves on disk.
 *   3. Showcase id ↔ path consistency — entry id matches filename.
 *   4. Recipe doc + test pair — both files exist and reference each
 *      other consistently.
 *   5. Cross-reference resolution — every `related[]`,
 *      `composes.adapters[]`, etc. id resolves to a registered entry.
 *   6. Spec anchor existence — every `spec` value of the form
 *      `FILE.md#anchor` resolves to a real markdown heading.
 *
 * Deferred to Phase 2+:
 *   - Orphan check (every file under tracked directories must be
 *     referenced by exactly one entry). Cannot land in Phase 1 because
 *     the registry is intentionally sparse — most existing files
 *     aren't registered yet, and the orphan check needs a populated
 *     registry to be useful.
 *   - Diagram render-drift check (rendered SVG matches MMD source).
 *     Lands when the first diagrams are added in Phase 2/3.
 *
 * Exits 0 on success, 1 with a grouped report on failure.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import Ajv from 'ajv'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const REGISTRY_PATH = join(ROOT, 'features.yaml')
const SCHEMA_PATH = join(ROOT, 'scripts/feature-schema.json')

// ─── Reporting ─────────────────────────────────────────────────────────

const failures = []
function fail(check, message, where = '') {
  failures.push({ check, message, where })
}

// ─── Load + parse ──────────────────────────────────────────────────────

if (!existsSync(REGISTRY_PATH)) {
  console.error(`✗ ${REGISTRY_PATH} not found`)
  process.exit(1)
}

let registry
try {
  registry = yaml.load(readFileSync(REGISTRY_PATH, 'utf8'))
} catch (err) {
  console.error(`✗ features.yaml: ${err.message}`)
  process.exit(1)
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))

// ─── Check 1: Schema ───────────────────────────────────────────────────

const ajv = new Ajv({ allErrors: true, strict: false })
const validate = ajv.compile(schema)
if (!validate(registry)) {
  for (const err of validate.errors ?? []) {
    fail('schema', `${err.instancePath || '/'} ${err.message}${err.params ? ` (${JSON.stringify(err.params)})` : ''}`)
  }
}

// Sections that hold registry entries. `recipes` has its own shape; the
// other six all derive from `baseEntry`.
const ENTRY_SECTIONS = ['features', 'adapters', 'frameworks', 'auths', 'exports', 'transports']
const ALL_SECTIONS = [...ENTRY_SECTIONS, 'topologies', 'recipes']

function* allEntries() {
  for (const section of ALL_SECTIONS) {
    for (const entry of registry[section] ?? []) {
      yield { section, entry }
    }
  }
}

// ─── Check 2: Path round-trip ──────────────────────────────────────────

function checkPath(p, ctx) {
  if (typeof p !== 'string') return
  const abs = join(ROOT, p)
  if (!existsSync(abs)) {
    fail('paths', `path "${p}" does not resolve`, ctx)
    return false
  }
  return true
}

for (const { section, entry } of allEntries()) {
  const ctx = `${section}/${entry.id}`
  if (entry.subsystem_doc) checkPath(entry.subsystem_doc, `${ctx}.subsystem_doc`)
  for (const sc of entry.showcases ?? []) checkPath(sc.path, `${ctx}.showcases.${sc.id}`)
  for (const pp of entry.playground_pages ?? []) checkPath(pp.path, `${ctx}.playground_pages`)
  for (const d of entry.diagrams ?? []) {
    checkPath(d.path, `${ctx}.diagrams`)
    checkPath(d.source, `${ctx}.diagrams.source`)
  }
  if (entry.doc) checkPath(entry.doc, `${ctx}.doc`)
  if (entry.showcase_path) checkPath(entry.showcase_path, `${ctx}.showcase_path`)
}

// ─── Check 3: Showcase id ↔ path ───────────────────────────────────────

for (const { section, entry } of allEntries()) {
  for (const sc of entry.showcases ?? []) {
    if (!sc.path || !sc.id) continue
    // Recipes use `.recipe.test.ts`. Showcases default to `.showcase.test.ts`
    // (or `.tsx`); showcases that must execute inside the Cloudflare Workers
    // runtime via vitest-pool-workers are named `.workers.test.ts` so the
    // main vitest config (happy-dom) skips them and the workers config picks
    // them up. All variants resolve to the same id-derived stem.
    const stem = `showcases/src/${sc.id}`
    const accepted = sc.id.startsWith('recipe-')
      ? [`${stem}.recipe.test.ts`]
      : [
          `${stem}.showcase.test.ts`,
          `${stem}.showcase.test.tsx`,
          `${stem}.workers.test.ts`,
        ]
    if (!accepted.includes(sc.path)) {
      fail(
        'id-path-mismatch',
        `path "${sc.path}" does not match any of: ${accepted.map((p) => `"${p}"`).join(', ')} (derived from id "${sc.id}")`,
        `${section}/${entry.id}`,
      )
    }
  }
}

// ─── Check 4: Recipe pairing ───────────────────────────────────────────

for (const r of registry.recipes ?? []) {
  // doc and showcase_path are validated by checkPath; here we verify
  // the basenames line up.
  if (r.doc && r.showcase_path) {
    const docSlug = r.doc.replace(/^docs\/recipes\//, '').replace(/\.md$/, '')
    const showcaseSlug = r.showcase_path
      .replace(/^showcases\/src\/recipe-/, '')
      .replace(/\.recipe\.test\.ts$/, '')
    if (docSlug !== showcaseSlug && docSlug !== r.id && showcaseSlug !== r.id) {
      fail(
        'recipe-pair',
        `recipe "${r.id}" doc slug "${docSlug}" and showcase slug "${showcaseSlug}" must agree with the id`,
        `recipes/${r.id}`,
      )
    }
  }
}

// ─── Check 5: Cross-reference resolution ───────────────────────────────

const knownIds = new Map() // id → section
for (const { section, entry } of allEntries()) {
  if (knownIds.has(entry.id)) {
    fail('duplicate-id', `id "${entry.id}" registered twice`, `${section}/${entry.id}`)
  }
  knownIds.set(entry.id, section)
}

function resolveRef(id, validSections, ctx) {
  if (!knownIds.has(id)) {
    fail('xref', `id "${id}" referenced but not registered`, ctx)
    return
  }
  const sec = knownIds.get(id)
  if (validSections && !validSections.includes(sec)) {
    fail(
      'xref',
      `id "${id}" lives in "${sec}" but the reference site expects one of [${validSections.join(', ')}]`,
      ctx,
    )
  }
}

for (const { section, entry } of allEntries()) {
  const ctx = `${section}/${entry.id}`
  for (const id of entry.related ?? []) resolveRef(id, null, `${ctx}.related`)
  for (const id of entry.recipes ?? []) resolveRef(id, ['recipes'], `${ctx}.recipes`)

  if (entry.composes) {
    for (const [k, ids] of Object.entries(entry.composes)) {
      for (const id of ids ?? []) {
        const expectedSection = k // adapters → 'adapters', etc.
        resolveRef(id, [expectedSection], `${ctx}.composes.${k}`)
      }
    }
  }

  if (entry.exercises) {
    for (const [k, ids] of Object.entries(entry.exercises)) {
      for (const id of ids ?? []) resolveRef(id, [k], `${ctx}.exercises.${k}`)
    }
  }
}

// ─── Check 6: Spec anchor existence ────────────────────────────────────

const headingCache = new Map() // file → Set<anchor>
function loadHeadings(file) {
  if (headingCache.has(file)) return headingCache.get(file)
  const abs = join(ROOT, file)
  const set = new Set()
  if (!existsSync(abs)) {
    headingCache.set(file, set)
    return set
  }
  const md = readFileSync(abs, 'utf8')
  for (const line of md.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const slug = m[1]
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
    set.add(slug)
  }
  headingCache.set(file, set)
  return set
}

for (const { section, entry } of allEntries()) {
  if (typeof entry.spec !== 'string' || !entry.spec.includes('#')) continue
  const [file, anchor] = entry.spec.split('#')
  if (!existsSync(join(ROOT, file))) {
    fail('spec-anchor', `spec file "${file}" not found`, `${section}/${entry.id}`)
    continue
  }
  const headings = loadHeadings(file)
  if (!headings.has(anchor)) {
    fail(
      'spec-anchor',
      `spec "${entry.spec}" — anchor "${anchor}" not found in "${file}"`,
      `${section}/${entry.id}`,
    )
  }
}

// ─── Run ───────────────────────────────────────────────────────────────

if (failures.length === 0) {
  const counts = ALL_SECTIONS.map((s) => `${s}=${registry[s]?.length ?? 0}`).join(', ')
  let experimentalCount = 0
  const experimentalEntries = []
  for (const { section, entry } of allEntries()) {
    if (entry.experimental) {
      experimentalCount++
      experimentalEntries.push(`${section}/${entry.id}`)
    }
  }
  console.log(`✓ features.yaml OK (${counts})`)
  if (experimentalCount > 0) {
    console.log(`  experimental=${experimentalCount} (${experimentalEntries.join(', ')})`)
  }
  process.exit(0)
}

const byCheck = new Map()
for (const f of failures) {
  if (!byCheck.has(f.check)) byCheck.set(f.check, [])
  byCheck.get(f.check).push(f)
}

console.error(`\n✗ features.yaml validation failed: ${failures.length} issue(s) across ${byCheck.size} check(s)\n`)
for (const [check, items] of byCheck) {
  console.error(`── ${check} (${items.length}) ──`)
  for (const item of items) {
    console.error(`  ${item.where ? item.where + ': ' : ''}${item.message}`)
  }
  console.error('')
}
process.exit(1)
