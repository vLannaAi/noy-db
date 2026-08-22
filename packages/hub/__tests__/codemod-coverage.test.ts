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
import { uncoveredLosses, uncoveredSubpathLosses, mappedFroms, mappedSubpaths } from '../scripts/check-codemod-coverage.mjs'

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

describe('mappedSubpaths', () => {
  const io = (maps: Record<string, unknown>) => ({
    read: (f: string) => JSON.stringify(maps[f.split('/').pop()!]),
    readDir: () => Object.keys(maps),
  })

  it('collects only `subpath` rows, not every rename', () => {
    expect([...mappedSubpaths('/c', io({
      'a.json': { renames: [
        { from: '@noy-db/hub/old', kind: 'subpath' },
        { from: 'SomeType', kind: 'type' },
      ] },
    }))]).toEqual(['@noy-db/hub/old'])
  })

  it('DROPS a subpath a later line re-introduced', () => {
    // `/at` and `/by` are exactly this: retired in 0.4, back in 0.7 because
    // something now stands behind them. A re-introduced path is not a loss,
    // and reporting it as one would push someone to add a row describing a
    // migration that has been undone.
    expect([...mappedSubpaths('/c', io({
      'old.json': { renames: [{ from: '@noy-db/hub/at', kind: 'subpath' }] },
      'new.json': { unretired: ['@noy-db/hub/at'] },
    }))]).toEqual([])
  })

  it('un-retirement is order-independent across map files', () => {
    // readDir order is the filesystem's business, and the two maps are read in
    // whatever order it gives. Retire-then-unretire must win either way.
    expect([...mappedSubpaths('/c', io({
      'z-new.json': { unretired: ['@noy-db/hub/by'] },
      'a-old.json': { renames: [{ from: '@noy-db/hub/by', kind: 'subpath' }] },
    }))]).toEqual([])
  })
})

describe('uncoveredSubpathLosses', () => {
  const S = (...xs: string[]) => new Set(xs)

  it('reports a subpath that vanished with no row — the /by and /with case', () => {
    expect(uncoveredSubpathLosses(
      S('@noy-db/hub', '@noy-db/hub/by'),
      S('@noy-db/hub'),
      S(),
    )).toEqual(['@noy-db/hub/by'])
  })

  it('accepts a vanished subpath that a map retired', () => {
    expect(uncoveredSubpathLosses(
      S('@noy-db/hub/as'),
      S(),
      S('@noy-db/hub/as'),
    )).toEqual([])
  })

  it('says nothing about a subpath that was never in the baseline', () => {
    // `/at` and `/by` are re-introduced in the 0.7 line and are absent from
    // the 0.6.0 baseline, so REMOVING them again cannot be a loss against it.
    // Verified against the real baseline, where both are absent — an
    // expectation I got wrong before checking, having assumed the unretired
    // list was what protected them.
    const baselineWithoutAt = S('@noy-db/hub', '@noy-db/hub/cargo')
    const currentWithoutAt = S('@noy-db/hub', '@noy-db/hub/cargo')
    expect(uncoveredSubpathLosses(baselineWithoutAt, currentWithoutAt, S())).toEqual([])
  })
})
