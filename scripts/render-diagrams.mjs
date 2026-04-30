#!/usr/bin/env node
/**
 * Renders Mermaid `.mmd` sources under `docs/assets/diagrams/` into
 * tracked `.svg` siblings. CI then runs `git diff --exit-code` over the
 * output to catch un-checked-in renders.
 *
 * Phase 1: stub. With zero diagrams in `features.yaml`, this script
 * walks the diagram directory and reports "0 sources, nothing to do."
 * The mmdc dependency (`@mermaid-js/mermaid-cli`) is heavy (Puppeteer +
 * headless Chromium) so we defer installing it until the first real
 * `.mmd` source lands in Phase 2/3.
 *
 * When that happens, swap the noop branch for a real `mmdc` invocation.
 */

import { existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const DIAGRAMS_DIR = join(ROOT, 'docs/assets/diagrams')

if (!existsSync(DIAGRAMS_DIR)) {
  console.log('✓ docs/assets/diagrams/ does not exist yet — nothing to render.')
  process.exit(0)
}

const sources = readdirSync(DIAGRAMS_DIR).filter((f) => f.endsWith('.mmd'))

if (sources.length === 0) {
  console.log('✓ No .mmd sources in docs/assets/diagrams/ — nothing to render.')
  process.exit(0)
}

console.error(
  `✗ Found ${sources.length} .mmd source(s) but the renderer is not yet implemented.`,
)
console.error(`  Install @mermaid-js/mermaid-cli and update scripts/render-diagrams.mjs.`)
console.error(`  Sources:\n${sources.map((s) => `    - ${s}`).join('\n')}`)
process.exit(1)
