/**
 * #1310 — the preamble convention for `check-prose-examples`.
 *
 * The gate compiled only fenced blocks that OPEN WITH AN IMPORT; 20 of 58
 * shipped blocks had none and were checked by nothing, including real
 * "does the signature accept this argument" claims and the in-nuxt config
 * block that shipped a wrong key AND a value outside the union. The family
 * chose the preamble convention (lanna-db #3, option a): every block
 * compiles; a file whose blocks elide their setup carries it once, in an
 * HTML comment that renders nowhere:
 *
 *     <!-- prose-preamble
 *     import type { Noydb } from '@noy-db/hub'
 *     declare const db: Noydb
 *     -->
 *
 * The preamble is prepended to every import-less block in that file. It
 * must TYPE the elided bindings, not merely import: an untyped `db` makes
 * `db.listAccessibleVaults({ minRole: 'admin' })` compile vacuously — the
 * exact laundering the gate's own header records for in-vue.
 */
import { describe, it, expect } from 'vitest'
import { extractBlocks, extractPreamble, prepareBlocks } from '../prose-examples/blocks.mjs'

const md = (...lines: string[]) => lines.join('\n') + '\n'

describe('extractPreamble', () => {
  it('reads the body of a <!-- prose-preamble … --> comment and its 1-based start line', () => {
    const text = md('# Title', '', '<!-- prose-preamble', "import type { Noydb } from '@noy-db/hub'", 'declare const db: Noydb', '-->', '', 'prose')
    expect(extractPreamble(text)).toEqual({
      code: "import type { Noydb } from '@noy-db/hub'\ndeclare const db: Noydb",
      line: 4,
      lines: 2,
    })
  })

  it('returns null when the file carries no preamble', () => {
    expect(extractPreamble(md('# Title', '```ts', 'const x = 1', '```'))).toBeNull()
  })

  it('refuses a second preamble — one per file, or the mapping is ambiguous', () => {
    const text = md('<!-- prose-preamble', 'a', '-->', '<!-- prose-preamble', 'b', '-->')
    expect(() => extractPreamble(text)).toThrow(/one prose-preamble/)
  })
})

describe('extractBlocks', () => {
  it('collects fenced ts blocks with their 1-based first code line and whether they open with an import', () => {
    const text = md('# T', '```ts', "import { a } from 'b'", 'a()', '```', '', '```ts', 'db.x()', '```')
    const blocks = extractBlocks(text, { isSource: false })
    expect(blocks).toEqual([
      { line: 3, code: "import { a } from 'b'\na()", hasImport: true },
      { line: 8, code: 'db.x()', hasImport: false },
    ])
  })
})

describe('prepareBlocks — the convention applied', () => {
  const preambled = md(
    '<!-- prose-preamble',
    "import type { Noydb } from '@noy-db/hub'",
    'declare const db: Noydb',
    '-->',
    '```ts',
    "import { createNoydb } from '@noy-db/hub'",
    'createNoydb({})',
    '```',
    '```ts',
    'await db.listAccessibleVaults()',
    '```',
  )

  it('prepends the preamble to import-less blocks only, and records the offset for diagnostic mapping', () => {
    const { blocks, missingPreamble } = prepareBlocks(preambled, { isSource: false, requirePreamble: true })
    expect(missingPreamble).toBe(false)
    expect(blocks).toHaveLength(2)
    // the importing block is untouched
    expect(blocks[0]).toMatchObject({ line: 6, preambleLines: 0 })
    expect(blocks[0]!.code.startsWith('import { createNoydb }')).toBe(true)
    // the import-less block carries the preamble ahead of its own code
    expect(blocks[1]).toMatchObject({ line: 10, preambleLines: 2 })
    expect(blocks[1]!.code).toBe("import type { Noydb } from '@noy-db/hub'\ndeclare const db: Noydb\nawait db.listAccessibleVaults()")
  })

  it('a file with import-less blocks and NO preamble is reported as missing one when required — the former blind spot is now a finding', () => {
    const text = md('```ts', 'await db.listAccessibleVaults()', '```')
    const { blocks, missingPreamble } = prepareBlocks(text, { isSource: false, requirePreamble: true })
    expect(missingPreamble).toBe(true)
    // …and the block is still emitted un-preambled, so pass 1/2 still see it.
    expect(blocks[0]).toMatchObject({ preambleLines: 0, hasImport: false })
  })

  it('a file with only importing blocks needs no preamble', () => {
    const text = md('```ts', "import { a } from 'b'", 'a()', '```')
    expect(prepareBlocks(text, { isSource: false, requirePreamble: true }).missingPreamble).toBe(false)
  })

  it('when the preamble is not required (PROSE_EXTRA), a missing one is not a finding but import-less blocks are still emitted for counting', () => {
    const text = md('```ts', 'db.x()', '```')
    const r = prepareBlocks(text, { isSource: false, requirePreamble: false })
    expect(r.missingPreamble).toBe(false)
    expect(r.blocks[0]).toMatchObject({ hasImport: false, preambleLines: 0 })
  })

  it('maps a diagnostic row back to a prose line: past the preamble → block line, inside it → the preamble line', () => {
    const { blocks, preamble } = prepareBlocks(preambled, { isSource: false, requirePreamble: true })
    const b = blocks[1]!
    // row 3 of the probe is the block's own first line (preamble is 2 lines)
    expect(b.line + (3 - 1) - b.preambleLines).toBe(10)
    // row 1 is inside the preamble → report at the preamble's own line
    expect(preamble!.line + (1 - 1)).toBe(2)
  })
})
