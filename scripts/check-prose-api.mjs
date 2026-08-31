#!/usr/bin/env node
/**
 * check-prose-api — does every method our prose attributes to `db` / `vault` /
 * `collection` actually exist on the published surface?
 *
 * ## The class this catches
 *
 * #1072 added a fenced-IMPORT check to README/SERVICES.md and found three
 * services documented that had never existed. Imports are only half the surface:
 * prose also names methods, and that half was unchecked. Everything found there
 * since lived in prose, not in a fence —
 *
 *   canExportPlaintext / canExportBundle   two "capability gates", neither ever a symbol
 *   header.cover                           taught with a fabricated return value
 *   db.openVaultGroup()                    a method on klum-db's Lobby, not on Noydb
 *
 * A rename leaves a trail a codemod map can follow. Invented API leaves none: no
 * compiler, test or reviewer has ever executed the claim.
 *
 * ## Why the scope is `db.` / `vault.` / `collection.` and not every identifier
 *
 * Measured. Checking every backticked call in SERVICES.md produced 7 candidates
 * and 6 were correct — `toPostgres()`, `useLiveQuery()` and friends are sibling
 * packages' exports, correctly attributed, and hub cannot answer for them. A
 * 14% signal rate is a report, not a gate.
 *
 * Scoped to hub's OWN objects it is 1 for 1, because `db.x()` IS a claim about
 * this package. That is the difference between a check that examines the right
 * thing and one that examines everything.
 *
 * Run: node scripts/check-prose-api.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const HUB = 'packages/hub'
// Every symbol the published .d.ts surface declares or re-exports.
const surface = new Set()
;(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.d.ts')) {
      const t = readFileSync(p, 'utf8')
      for (const m of t.matchAll(/\b(?:declare )?(?:export )?(?:abstract )?(?:class|interface|type|function|const|enum)\s+([A-Za-z_$][\w$]*)/g)) surface.add(m[1])
      for (const m of t.matchAll(/export\s*\{([^}]*)\}/g))
        for (const part of m[1].split(',')) {
          const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
          if (n && /^[A-Za-z_$][\w$]*$/.test(n)) surface.add(n)
        }
      // members: `foo(...)` and `readonly foo:` inside declarations
      for (const m of t.matchAll(/^\s*(?:readonly\s+)?([a-z_$][\w$]*)\s*[(:?<]/gm)) surface.add(m[1])
    }
  }
})(join(HUB, 'dist'))

// SERVICES.md moved to the private family layer (2026-08-31 restructure); the
// private runner re-adds it via PROSE_EXTRA. Entries must exist — a silent
// skip would pass while examining nothing.
const extra = (process.env.PROSE_EXTRA ?? '').split(',').filter(Boolean)
for (const f of extra) if (!existsSync(f)) { console.error(`PROSE_EXTRA entry does not exist: ${f}`); process.exit(1) }
const prose = [join(HUB, 'README.md')].filter(existsSync).concat(extra)
const seen = new Map()
for (const f of prose) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('```')) return
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const raw = m[1].trim()
      if (raw.includes('/') || raw.includes(' ') || /\.(ts|md|json)\b/.test(raw)) continue
      // ONLY claims about hub's own objects — see the scope note above.
      const id = raw.match(/^(?:db|vault|collection|noydb)\.([A-Za-z_$][\w$]*)\s*\(/)?.[1]
      if (!id) continue
      if (surface.has(id)) continue
      const key = id
      if (!seen.has(key)) seen.set(key, [])
      seen.get(key).push(`${f.split('/').pop()}:${i + 1}`)
    }
  })
}
console.log(`published surface symbols: ${surface.size}`)
if (!seen.size) {
  console.log('✓ every method our prose attributes to db/vault/collection exists on the published surface')
  process.exit(0)
}
console.error(`\n✗ ${seen.size} method(s) attributed to db/vault/collection do not exist:\n`)
for (const [id, where] of [...seen].sort((a, b) => b[1].length - a[1].length))
  console.error(`  ${id.padEnd(32)} ${where.join(', ')}`)
console.error(`\nEither the method was renamed, or it belongs to a sibling package and the prose
should say so. Nothing compiles a markdown file, so this is the only thing that
looks — see #1072.`)
process.exit(1)
