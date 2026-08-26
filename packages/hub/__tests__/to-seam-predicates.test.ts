import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as to from '../src/port/to/index.js'

/**
 * #1224 — a predicate a store-seam catch is REQUIRED to use must be reachable
 * from the subpath a store actually binds.
 *
 * `isConflictError` exists because a store may bind a different copy of
 * `@noy-db/hub/to` than the caller, making `instanceof` silently miss. A store
 * binds `/to` and nothing else, so exporting the predicate only from the root
 * barrel told store authors to use something they could not import.
 */
describe('store-seam predicates are reachable from /to (#1224)', () => {
  it('exports isConflictError', () => {
    expect(typeof to.isConflictError).toBe('function')
  })

  it('the predicate actually works on a foreign-identity ConflictError', () => {
    // The whole point: a DIFFERENT class identity, as a duplicated hub copy
    // would produce. `instanceof` misses this; the name check does not.
    const foreign = Object.assign(new Error('Version conflict'), {
      name: 'ConflictError',
      version: 7,
    })
    expect(foreign instanceof to.ConflictError).toBe(false)  // the trap
    expect(to.isConflictError(foreign)).toBe(true)           // the fix
  })

  it('does not match unrelated errors', () => {
    expect(to.isConflictError(new Error('nope'))).toBe(false)
    expect(to.isConflictError(null)).toBe(false)
    expect(to.isConflictError({ name: 'NetworkError' })).toBe(false)
  })

  it('INVARIANT: every store-seam predicate in errors.ts is on /to', () => {
    // Output-domain, not an enumeration: if a sibling predicate is ever added
    // whose contract names the store seam, this fails until /to exports it.
    const src = readFileSync(
      fileURLToPath(new URL('../src/kernel/errors.ts', import.meta.url)), 'utf8',
    )
    const required = [...src.matchAll(/\/\*\*([\s\S]*?)\*\/\s*export function (is[A-Z]\w*)/g)]
      .map(m => ({ doc: m[1] ?? '', name: m[2] ?? '' }))
      .filter(m => m.name !== '' && /\bstore\b/i.test(m.doc))
      .map(m => m.name)

    expect(required.length).toBeGreaterThan(0)  // the query must be able to find something
    for (const name of required) {
      expect(to, `${name} is required at store-seam catches but is not on /to`)
        .toHaveProperty(name)
    }
  })
})
