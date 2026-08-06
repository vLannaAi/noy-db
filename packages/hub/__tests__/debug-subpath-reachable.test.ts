/**
 * #914 — the `debugPlaintext` inspection cluster must be reachable from a
 * published entry.
 *
 * `debugPlaintext: true` is a supported `createNoydb` option. Its two failure
 * modes (`DebugPlaintextError`, `DebugReservedFieldError`) are thrown straight
 * at the caller, and `readPlaintextRecord` is the reader for the layout the
 * option produces. #843(c) pruned all three off the root barrel on a
 * "zero barrel imports" signal — true in-monorepo, where every use reaches the
 * source module directly, but an npm consumer only has the exports map. The
 * result: an option whose documented error could not be caught, and a helper
 * whose own `@example` could not be run.
 *
 * This walks the BUILT bundles rather than source, because that is what a
 * consumer resolves — the same reason `no-stub-subpath-exports.test.ts` does.
 * Runtime exports, not a `.d.ts` grep: an `export *` barrel names nothing
 * textually while still carrying the binding.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(HUB, 'package.json'), 'utf8')) as {
  exports: Record<string, { types: string; default: string } | string>
}

/**
 * Every published CODE entry, as `[subpath, built JS path]`.
 *
 * A string condition is a published data asset, not a module — `codemods/*`
 * (#994) is a JSON rename map with no bundle to import.
 */
const CODE_EXPORTS = Object.fromEntries(
  Object.entries(pkg.exports).filter(
    (e): e is [string, { types: string; default: string }] => typeof e[1] !== 'string',
  ),
)
const ENTRIES = Object.entries(CODE_EXPORTS).map(
  ([subpath, cond]) => [subpath, join(HUB, cond.default)] as const,
)

/** The subpaths a consumer can reach `name` from, by runtime export. */
async function reachableFrom(name: string): Promise<string[]> {
  const hits: string[] = []
  for (const [subpath, js] of ENTRIES) {
    if (!existsSync(js)) continue
    const mod = (await import(pathToFileURL(js).href)) as Record<string, unknown>
    if (mod[name] !== undefined) hits.push(subpath)
  }
  return hits
}

describe('#914 — debugPlaintext inspection cluster is reachable', () => {
  const built = existsSync(join(HUB, 'dist'))

  it.runIf(built).each([
    'readPlaintextRecord',
    'DebugPlaintextError',
    'DebugReservedFieldError',
  ])('%s is exported from a published subpath', async (name) => {
    const hits = await reachableFrom(name)
    expect(
      hits,
      `${name} ships in dist but no entry in the exports map re-exports it — ` +
        `an npm consumer has no way to import it`,
    ).not.toEqual([])
  })

  it.runIf(built)('the error createNoydb throws is instanceof the exported class', async () => {
    const debug = (await import(
      pathToFileURL(join(HUB, CODE_EXPORTS['./debug']!.default)).href
    )) as { DebugPlaintextError: new () => Error }
    const root = (await import(
      pathToFileURL(join(HUB, CODE_EXPORTS['.']!.default)).href
    )) as { createNoydb: (o: Record<string, unknown>) => Promise<unknown> }

    // `debugPlaintext` with encryption left on is the documented failure mode.
    await expect(
      root.createNoydb({ user: 'u', secret: 'pw-long-enough-here', debugPlaintext: true }),
    ).rejects.toBeInstanceOf(debug.DebugPlaintextError)
  })
})
