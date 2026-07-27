/**
 * #844(c) — every service's `NO_*` stub must be reachable from that service's
 * own subpath.
 *
 * The stubs are how a caller asks "is this service actually enabled?" — the
 * check is an identity comparison against the stub (see `vault.forget()`'s
 * `strategies.blob !== NO_BLOBS`, #838). Several subpath docblocks tell users
 * to do exactly that, while the stub was exported from no entry they could
 * import, so the advice was unfollowable.
 *
 * This walks the BUILT declarations rather than source, because that is what a
 * consumer resolves, and it strips comments first — a stub named only in a
 * docblock is precisely the failure this guards against.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(HUB, 'package.json'), 'utf8')) as {
  exports: Record<string, { types: string }>
}

/** stub → the subpath that owns the service it stubs out. */
const OWNED: ReadonlyArray<readonly [string, string]> = [
  ['NO_BLOBS', './blobs'],
  ['NO_I18N', './i18n'],
  ['NO_SESSION', './session'],
  ['NO_HISTORY', './history'],
  ['NO_CRDT', './crdt'],
  ['NO_SHADOW', './shadow'],
  ['NO_SNAPSHOTS', './snapshots'],
  ['NO_SYNC', './sync'],
  ['NO_INDEXING', './indexing'],
  ['NO_AGGREGATE', './aggregate'],
  ['NO_CONSENT', './consent'],
  ['NO_PERIODS', './periods'],
]

function codeOf(declPath: string): string {
  const s = readFileSync(declPath, 'utf8')
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
}

describe('NO_* stubs are reachable from their own subpath (#844c)', () => {
  const built = existsSync(join(HUB, 'dist'))

  it.runIf(built).each(OWNED)('%s is exported from %s', (stub, subpath) => {
    const entry = pkg.exports[subpath]
    expect(entry, `${subpath} is not in the exports map`).toBeDefined()

    const decl = join(HUB, entry!.types)
    expect(existsSync(decl), `${decl} not built`).toBe(true)

    // Comments stripped: being named in a docblock is not being exported.
    expect(codeOf(decl)).toContain(stub)
  })
})
