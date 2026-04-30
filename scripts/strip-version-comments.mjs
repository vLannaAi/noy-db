#!/usr/bin/env node
/**
 * Strip historical v0.x version chatter from source-code JSDoc and inline
 * comments. Used once during the pre-release reset to clean the slate
 * for new developers and auto-evaluation tooling.
 *
 * Run from repo root:  node scripts/strip-version-comments.mjs
 *
 * Walks packages/<name>/src/**\/*.ts and applies four transforms:
 *
 *   1. Drop parenthetical version annotations: "(v0.18 #205)" → ""
 *      (also " - v0.18 #205", "v0.18 #205", "v0.18.1", "v0.4 follow-up", etc.
 *      when they appear inside other text).
 *   2. Delete `// vX.Y ...` line comments that are version-only chatter.
 *   3. Delete ` * vX.Y ...` JSDoc lines that are version-only chatter.
 *   4. Delete `// #N` / ` * #N` lines that are pure issue-reference noise.
 *
 * Multi-purpose comments are LEFT INTACT so a manual second-pass review
 * can rewrite them to describe behavior without version anchoring.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const FILES = execSync(
  `find packages -type d -name node_modules -prune -o -path 'packages/*/src' -prune -print`,
  { encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean)
  .flatMap((dir) =>
    execSync(`find "${dir}" -type f -name "*.ts" -not -name "*.d.ts"`, { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean),
  )

let totalFiles = 0
let totalChanges = 0

for (const file of FILES) {
  const original = readFileSync(file, 'utf8')
  let s = original

  // 1. Strip parenthetical / dash-prefixed / bare version annotations
  //    embedded in larger comments. Examples we want to remove:
  //      "v0.6 #74 — produces"            → "produces"
  //      "v0.18 #205 — tier-aware put."   → "tier-aware put."
  //      "(v0.18 #209)"                   → ""
  //      "(#291)"                         → ""
  //      " (v0.4 follow-up)"              → ""
  //      "v0.21 #257"                     → ""
  s = s.replace(/\s*\(v0\.\d+(?:\.\d+)?(?:\s*#\d+)?[^)]*\)/g, '')
  s = s.replace(/^(\s*\*\s*)v0\.\d+(?:\.\d+)?(?:\s*#\d+)?\s*[—\-:]\s*/gm, '$1')
  s = s.replace(/^(\s*\/\/\s*)v0\.\d+(?:\.\d+)?(?:\s*#\d+)?\s*[—\-:]\s*/gm, '$1')
  s = s.replace(/\s+v0\.\d+(?:\.\d+)?(?:\s*#\d+)?(?=\s|$|\.|,)/g, '')
  s = s.replace(/^(\s*\*\s*)\(?#\d+\)?\s*[—\-:]\s*/gm, '$1')
  s = s.replace(/\s*\(#\d+\)/g, '')

  // 2. Pure version-only `//` line comments → delete the whole line.
  //    Matches "// v0.5", "// v0.18 #205", "// v0.4 follow-up".
  s = s.replace(/^[ \t]*\/\/\s*v0\.\d+(?:\.\d+)?(?:\s*#\d+)?\s*(?:\w+(?:[ -]\w+)*)?\s*$\n/gm, '')

  // 3. Pure version-only ` *` JSDoc lines → delete the whole line.
  s = s.replace(/^[ \t]*\*\s*v0\.\d+(?:\.\d+)?(?:\s*#\d+)?\s*(?:\w+(?:[ -]\w+)*)?\s*$\n/gm, '')

  // 4. Pure issue-only ` *` JSDoc lines → delete.
  s = s.replace(/^[ \t]*\*\s*#\d+\s*$\n/gm, '')
  s = s.replace(/^[ \t]*\/\/\s*#\d+\s*$\n/gm, '')

  // 5. Collapse double-blank-comment-lines that the deletions may have
  //    introduced inside JSDoc blocks.
  s = s.replace(/(^[ \t]*\*\s*$\n)(^[ \t]*\*\s*$\n)+/gm, '$1')

  // 6. Trim trailing whitespace on each line (the in-text replacements
  //    sometimes leave a stray space).
  s = s.replace(/[ \t]+$/gm, '')

  if (s !== original) {
    writeFileSync(file, s)
    totalFiles++
    const before = (original.match(/v0\.\d/g) || []).length
    const after = (s.match(/v0\.\d/g) || []).length
    totalChanges += before - after
  }
}

console.log(`Modified ${totalFiles} files, removed ${totalChanges} v0.x references.`)
