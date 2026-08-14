/**
 * `stripComments` — the shared comment stripper behind 15 architecture checks.
 *
 * ## Why this test exists
 *
 * Until 2026-08-14 it stripped **block comments before line comments**. That
 * ordering is silently wrong: a `//` comment that merely *mentions* a path or
 * glob containing `/*` — `// via/lookup/**` is the real example that exposed it
 * — reads as an opening block delimiter to the block regex, which then runs to
 * the next `*​/` anywhere in the file and deletes the real code in between.
 *
 * The failure mode is the one this repo keeps re-learning: **a check that looked
 * right and examined the wrong thing.** It did not error. It reported success
 * over a file whose body it had thrown away — `enclave-body-only` counted zero
 * protected-body accesses in a file that plainly had three.
 *
 * So these assert the PROPERTY (a line comment can never swallow code), not a
 * list of strings someone imagined. Every case here fails under the old order.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECKER = join(HERE, '..', 'check-architecture.mjs')

/**
 * The checker is a script, not a module with exports, so lift the function out
 * of its source rather than importing it. Reading the real source is the point:
 * a copy in this file would test the copy.
 */
function loadStripComments(): (s: string) => string {
  const src = readFileSync(CHECKER, 'utf8')
  const start = src.indexOf('function stripComments(content) {')
  expect(start, 'stripComments must exist in check-architecture.mjs').toBeGreaterThan(-1)
  const end = src.indexOf('\n}', start) + 2
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(`${src.slice(start, end)}; return stripComments`)() as (s: string) => string
}

const stripComments = loadStripComments()

/** Body-field regex, copied from the checker's `BODY_FIELD_ACCESS_RE`. */
const BODY = /\b_iv\s*:|\b_data\s*:|\._data\b/g
const count = (s: string) => (s.match(BODY) ?? []).length

describe('stripComments — a line comment must never swallow code', () => {
  it('1. THE BUG: `// …/**` must not delete the code that follows', () => {
    const src = [
      'function f() {',
      '  // via/lookup/** may not import the enclave',
      "  return { _iv: '', _data: json }",
      '}',
      '/** a real block comment, much later */',
      "const other = { _data: 'x' }",
    ].join('\n')

    // Under the old order the `/**` inside the line comment opened a phantom
    // block that ran to the real block's `*/`, deleting BOTH the return and
    // everything between — the count came back 1 instead of 3.
    expect(count(stripComments(src))).toBe(3)
  })

  it('2. the general property: stripping comments never removes a code line', () => {
    // Each mention is innocuous prose. None may cost us a line of code.
    const mentions = [
      'src/**',
      'a/*.ts',
      'foo/**/bar',
      'kernel/enclave/*',
      'see /* this */ inline',
    ]
    for (const m of mentions) {
      const src = [`  // ${m}`, "  const x = { _iv: '', _data: y }", '/* trailing block */'].join('\n')
      expect(count(stripComments(src)), `line comment mentioning "${m}" ate the code below it`).toBe(2)
    }
  })

  it('3. real block comments are still stripped', () => {
    const src = ["/* const hidden = { _iv: '' } */", "const real = { _data: 'y' }"].join('\n')
    expect(count(stripComments(src))).toBe(1)
  })

  it('4. multi-line block comments are still stripped', () => {
    const src = ['/**', " * const doc = { _iv: '' }", ' */', "const real = { _data: 'y' }"].join('\n')
    expect(count(stripComments(src))).toBe(1)
  })

  it('5. ordinary line comments are still stripped', () => {
    const src = ["// const dead = { _iv: '' }", "const real = { _data: 'y' }"].join('\n')
    expect(count(stripComments(src))).toBe(1)
  })

  it('6. the ordering is asserted in the source, so a future edit cannot silently revert it', () => {
    // The property tests above prove behaviour; this proves the REASON survives
    // next to the code. A stripper reordered without reading the comment is
    // exactly how this regresses.
    const src = readFileSync(CHECKER, 'utf8')
    const fn = src.slice(src.indexOf('function stripComments(content) {'))
    const lineIdx = fn.indexOf('// line comments')
    const blockIdx = fn.indexOf('/* ... */ and')
    expect(lineIdx, 'line-comment strip must come FIRST').toBeLessThan(blockIdx)
    expect(fn.slice(0, 600)).toMatch(/ORDER IS LOAD-BEARING/)
  })
})
