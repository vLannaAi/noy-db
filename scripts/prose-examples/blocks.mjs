/**
 * Block extraction + the preamble convention for `check-prose-examples` (#1310).
 *
 * Pure: no filesystem, no tsc. The script owns the I/O; this module owns the
 * two decisions that used to be a one-line regex there — which fenced blocks
 * exist, and what code each one compiles as.
 *
 * ## The preamble convention
 *
 * A block that opens with an import is self-contained and compiles as-is. A
 * block that does not is ILLUSTRATIVE — it elides its setup — and used to be
 * skipped, which left 20 of 58 shipped blocks checked by nothing (the
 * in-nuxt config block shipped a wrong key and a value outside the union
 * this way). The family chose (lanna-db #3, option a): every block compiles,
 * and a file whose blocks elide their setup declares it ONCE, in an HTML
 * comment that renders nowhere:
 *
 *     <!-- prose-preamble
 *     import type { Noydb, Collection } from '@noy-db/hub'
 *     declare const db: Noydb
 *     declare const invoices: Collection<{ id: string }>
 *     -->
 *
 * The preamble is prepended to every import-less block in that file. It
 * must TYPE the elided bindings — `declare const db: Noydb` — not merely
 * import: an untyped `db` (TS2304, ignored as probe noise) makes
 * `db.listAccessibleVaults({ minRole: 'admin' })` compile vacuously, which
 * is the laundering the gate's header records for in-vue.
 *
 * One preamble per file. Two would make the diagnostic-line mapping
 * ambiguous, so a second one is refused rather than merged.
 */

const PREAMBLE_OPEN = /^<!--\s*prose-preamble\s*$/
const PREAMBLE_CLOSE = /^-->\s*$/

/**
 * @param {string} text
 * @returns {{ code: string, line: number, lines: number } | null}
 *   `line` is the 1-based line of the preamble's first code line.
 */
export function extractPreamble(text) {
  const lines = text.split('\n')
  let found = null
  for (let i = 0; i < lines.length; i++) {
    if (!PREAMBLE_OPEN.test(lines[i])) continue
    if (found) throw new Error(`more than one prose-preamble in a file (lines ${found.line - 1} and ${i + 1}); a file carries one`)
    const buf = []
    let j = i + 1
    for (; j < lines.length && !PREAMBLE_CLOSE.test(lines[j]); j++) buf.push(lines[j])
    found = { code: buf.join('\n'), line: i + 2, lines: buf.length }
    i = j
  }
  return found
}

/**
 * Fenced ```ts / ```typescript / ```vue blocks, each with the 1-based line of
 * its first code line. `isSource` strips the ` * ` gutter of a JSDoc block so
 * the .d.ts-shipped module comment on `hub/src/index.ts` is scanned too.
 * A ```vue block contributes its <script> body (the template is not tsc's
 * language) with the line offset kept so diagnostics land on the right line.
 *
 * @param {string} text
 * @param {{ isSource: boolean }} opts
 * @returns {Array<{ line: number, code: string, hasImport: boolean }>}
 */
export function extractBlocks(text, { isSource }) {
  const blocks = []
  const lines = text.split('\n')
  let open = null, buf = [], fenceLang = ''
  lines.forEach((raw, i) => {
    const line = isSource ? raw.replace(/^\s*\*ic?\s?/, '').replace(/^\s*\*\s?/, '') : raw
    const fence = line.match(/^```(ts|typescript|vue)\s*$/)
    if (fence && open === null) { open = i + 2; buf = []; fenceLang = fence[1]; return }
    if (open !== null && /^```\s*$/.test(line)) {
      let code = buf.join('\n'), lineOff = 0
      if (fenceLang === 'vue') {
        const m = code.match(/<script[^>]*>\n([\s\S]*?)<\/script>/)
        if (m) { lineOff = code.slice(0, m.index).split('\n').length; code = m[1] }
        else code = ''
      }
      if (code.trim() !== '') blocks.push({ line: open + lineOff, code, hasImport: /^\s*import\s/m.test(code) })
      open = null; return
    }
    if (open !== null) buf.push(line)
  })
  return blocks
}

/**
 * The convention applied to one file.
 *
 * - importing blocks: compiled as written, `preambleLines: 0`.
 * - import-less blocks, file has a preamble: preamble + '\n' + code, and
 *   `preambleLines` records the offset so a diagnostic row maps back to
 *   prose (`line + row - 1 - preambleLines`; a row inside the preamble
 *   reports at the preamble's own line).
 * - import-less blocks, no preamble: emitted UN-preambled — pass 1/2 still
 *   see them — and `missingPreamble` is true when the caller requires one.
 *   Shipped prose requires it (that is the gate); PROSE_EXTRA does not, so
 *   the private docs layer can adopt the convention file by file.
 *
 * @param {string} text
 * @param {{ isSource: boolean, requirePreamble: boolean }} opts
 */
export function prepareBlocks(text, { isSource, requirePreamble }) {
  const preamble = extractPreamble(text)
  const raw = extractBlocks(text, { isSource })
  const blocks = raw.map((b) => {
    if (b.hasImport || !preamble) return { ...b, preambleLines: 0 }
    return { ...b, code: `${preamble.code}\n${b.code}`, preambleLines: preamble.lines }
  })
  const importless = raw.some((b) => !b.hasImport)
  return { blocks, preamble, missingPreamble: requirePreamble && importless && !preamble }
}
