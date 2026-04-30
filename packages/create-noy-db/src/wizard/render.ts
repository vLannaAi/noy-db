/**
 * Template loader and renderer.
 *
 * Templates live under `packages/create-noy-db/templates/<template-name>/`
 * as a literal directory tree. Files are read verbatim from disk; the
 * renderer walks the tree, substitutes a small set of placeholder tokens,
 * and writes the result to the target directory.
 *
 * The placeholder syntax is intentionally minimal: `{{TOKEN}}` (uppercase,
 * no spaces, no nested expressions). This avoids dragging in handlebars
 * or any templating library, keeps the bundle small, and means there's
 * exactly one rule to learn when authoring a template.
 *
 * Files whose names start with `_` are renamed to `.` on copy. This is
 * how we ship `_gitignore` (`.gitignore`) without npm trying to interpret
 * it as part of the package contents.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Tokens the renderer recognizes. Authoring rule for templates: every
 * placeholder must be a member of this set, otherwise template authors
 * will hit silent no-ops at render time.
 */
export interface RenderTokens {
  /** The user-supplied project name. Used for `package.json#name` etc. */
  PROJECT_NAME: string
  /** The chosen adapter (browser/file/memory). */
  ADAPTER: string
  /** "true" or "false" — written into `nuxt.config.ts` for `noydb.devtools`. */
  DEVTOOLS: string
  /** A literal `[...]` block of seed records, or `[]` if `sampleData` is false. */
  SEED_INVOICES: string
}

/**
 * Walks `src` recursively and copies every file into `dest`, substituting
 * `{{TOKEN}}` placeholders along the way.
 *
 * Returns the relative paths of every file written, sorted alphabetically.
 * Tests use this to assert that the expected file set was produced without
 * having to walk `dest` themselves.
 *
 * The function is intentionally synchronous-feeling (uses `await` inside
 * a depth-first walk) so the order of writes is deterministic — easier
 * to reason about when something fails halfway through.
 */
export async function renderTemplate(
  src: string,
  dest: string,
  tokens: RenderTokens,
): Promise<string[]> {
  const written: string[] = []
  await walk(src, dest, '', tokens, written)
  written.sort()
  return written
}

async function walk(
  srcRoot: string,
  destRoot: string,
  rel: string,
  tokens: RenderTokens,
  written: string[],
): Promise<void> {
  const srcDir = path.join(srcRoot, rel)
  const entries = await fs.readdir(srcDir, { withFileTypes: true })

  for (const entry of entries) {
    const srcEntry = path.join(srcDir, entry.name)
    // _gitignore → .gitignore, _npmrc → .npmrc, etc.
    // npm strips files starting with `.` from the published tarball, so
    // shipping them as `_<name>` is the standard workaround.
    const destName = entry.name.startsWith('_')
      ? `.${entry.name.slice(1)}`
      : entry.name
    const destRel = rel ? path.join(rel, destName) : destName
    const destEntry = path.join(destRoot, destRel)

    if (entry.isDirectory()) {
      await fs.mkdir(destEntry, { recursive: true })
      await walk(srcRoot, destRoot, path.join(rel, entry.name), tokens, written)
      continue
    }

    const raw = await fs.readFile(srcEntry, 'utf8')
    const rendered = applyTokens(raw, tokens)
    await fs.mkdir(path.dirname(destEntry), { recursive: true })
    await fs.writeFile(destEntry, rendered, 'utf8')
    written.push(destRel)
  }
}

/**
 * Substitutes every `{{KEY}}` in `input` with the corresponding value
 * from `tokens`. Unknown keys are left untouched (so the user can spot
 * them visually in the generated output if a template author makes a
 * typo). Empty values are allowed.
 */
export function applyTokens(input: string, tokens: RenderTokens): string {
  const bag = tokens as unknown as Record<string, string>
  return input.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = bag[key]
    return value === undefined ? match : value
  })
}

/**
 * Resolves the absolute path of a template directory shipped inside the
 * package. The package layout is:
 *
 *   packages/create-noy-db/
 *     dist/
 *       wizard/render.js   ← we are here at runtime (after tsup build)
 *     templates/
 *       nuxt-default/      ← we want to point at this
 *
 * In the published tarball the same relative path holds: `dist/` and
 * `templates/` are siblings under the package root. Computing the path
 * relative to `import.meta.url` lets us avoid hardcoding any assumption
 * about whether we're running from source, from `dist/`, or from a
 * globally installed copy.
 */
export function templateDir(name: string): string {
  // From `dist/wizard/render.js` we go up two levels to the package root,
  // then into `templates/<name>`.
  const here = fileURLToPath(import.meta.url)
  const packageRoot = path.resolve(path.dirname(here), '..', '..')
  return path.join(packageRoot, 'templates', name)
}
