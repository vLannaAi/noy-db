/**
 * `scripts/check-codemod-coverage.mjs` — the OUTPUT-DOMAIN half of the rename
 * contract, tested as pure functions.
 *
 * The weighting is deliberate. `codemod-map-0.6.test.ts` validates the rows
 * that are PRESENT and structurally cannot see a rename that is MISSING —
 * which is #1061 (`hasNoydbBundleMagic`) recurring as #1154
 * (`LiveAggregation`). `uncoveredLosses` is the half that must FIND something,
 * and a coverage check never seen to fail is the unexecuted claim it exists to
 * remove. So these cases are built from the real transitions between published
 * tarballs, including the two rows the check actually found.
 *
 * Mutation-checked, counts measured rather than estimated: dropping
 * `!mapped.has(s)` fails 4; dropping `!current.has(s)` fails 4; dropping the
 * `.sort()` fails 1.
 *
 * Reachability itself is NOT re-tested here — it is the TypeScript checker via
 * `scripts/lib/surface.mjs`, shared with `check-type-reachability.mjs`, and
 * exercised for real by both CI steps. Re-implementing an oracle for it in a
 * test would be testing the fixture.
 */
import { describe, it, expect } from 'vitest'
import { uncoveredLosses, mappedFroms } from '../scripts/check-codemod-coverage.mjs'

const S = (...xs: string[]) => new Set(xs)

describe('uncoveredLosses — the assertion that must be able to fire', () => {
  it('FINDS a symbol that left the surface with no map row — the #1154 shape', () => {
    // LiveAggregation: reachable in published 0.3.0, absent from 0.4.0, every
    // sibling mapped and itself not.
    expect(uncoveredLosses(
      S('LiveAggregation', 'AggregateResult', 'Vault'),
      S('LiveReduction', 'ReduceResult', 'Vault'),
      S('AggregateResult'),
    )).toEqual(['LiveAggregation'])
  })

  it('FINDS both rows the real 0.5.0 → 0.6.0 diff produced', () => {
    expect(uncoveredLosses(
      S('encodeBundleHeader', 'validateBundleHeader', 'hasNoydbBundleMagic', 'Vault'),
      S('encodePodHeader', 'validatePodHeaderFields', 'hasNoydbPodMagic', 'Vault'),
      S('hasNoydbBundleMagic'),
    )).toEqual(['encodeBundleHeader', 'validateBundleHeader'])
  })

  it('is QUIET on a clean transition — the measured 0.4.0 → 0.5.0 control', () => {
    // lost 0, unmapped 0. As load-bearing as the two cases above: a checker
    // that always finds something is a checker nobody reads.
    expect(uncoveredLosses(S('a', 'b', 'c'), S('a', 'b', 'c', 'd'), S())).toEqual([])
  })

  it('does not report a symbol that is still exported', () => {
    expect(uncoveredLosses(S('Vault'), S('Vault'), S())).toEqual([])
  })

  it('does not report a loss a map already covers', () => {
    expect(uncoveredLosses(S('old'), S('new'), S('old'))).toEqual([])
  })

  it('accepts a `removed` row — coverage means NAMED, not replaced', () => {
    // A deletion carries `to: null` and still lands in `mappedFroms`: the
    // contract is that a consumer can look the symbol up, not that it survived.
    expect(uncoveredLosses(S('deletedFeature'), S(), S('deletedFeature'))).toEqual([])
  })

  it('sorts, so a diff of the failure output is readable', () => {
    expect(uncoveredLosses(S('zeta', 'alpha', 'mid'), S(), S())).toEqual(['alpha', 'mid', 'zeta'])
  })
})

describe('mappedFroms', () => {
  it('unions every `from` across every shipped map, ignoring non-JSON', () => {
    const io = {
      read: (f: string) => f.endsWith('a.json')
        ? JSON.stringify({ renames: [{ from: 'one' }, { from: 'two' }] })
        : JSON.stringify({ renames: [{ from: 'three' }] }),
      readDir: () => ['a.json', 'b.json', 'README.md'],
    }
    expect([...mappedFroms('/codemods', io)].sort()).toEqual(['one', 'three', 'two'])
  })

  it('tolerates a map with no renames array rather than throwing mid-check', () => {
    const io = { read: () => JSON.stringify({ $comment: 'placeholder' }), readDir: () => ['x.json'] }
    expect([...mappedFroms('/codemods', io)]).toEqual([])
  })
})
