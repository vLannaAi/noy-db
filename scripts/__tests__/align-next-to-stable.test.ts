/**
 * The alignment job's decisions, tested as pure functions.
 *
 * The weighting here is deliberate. `derivePackages`/`planAlignment` fire on
 * every run and are easy to cover; `decideAction`'s REFUSAL never fires in a
 * passing run, which is exactly why it is the half that would otherwise ship
 * untested — and it is the half standing between a wrong `--version` and
 * `npm dist-tag add <pkg>@<never-published> next` across the whole line.
 *
 * Mutation-checked: deleting the `tags.latest !== version` guard must fail
 * several of these, not one.
 */
import { describe, it, expect } from 'vitest'
import { decideAction, planAlignment, derivePackages, confirmMoved, OWN_VERSION_LINE } from '../align-next-to-stable.mjs'

describe('decideAction — the refusal', () => {
  it('REFUSES when `latest` is not already the target — the catastrophic case', () => {
    // A wrong --version. `latest` sits on the real stable; this run claims 0.7.0,
    // which was never published. Blindly aligning would point `next` at nothing.
    const d = decideAction({ latest: '0.6.0', next: '0.6.0-pre.24' }, '0.7.0')
    expect(d.action).toBe('refuse')
    expect(d.why).toMatch(/latest.*0\.6\.0.*not 0\.7\.0/)
  })

  it('REFUSES when the target is a prerelease — a pre publish already sets `next`', () => {
    expect(decideAction({ latest: '0.6.0-pre.24', next: '0.6.0-pre.24' }, '0.6.0-pre.24').action).toBe('refuse')
  })

  it('REFUSES when there is no `latest` at all — the publish is unconfirmed', () => {
    expect(decideAction({ next: '0.6.0-pre.24' }, '0.6.0').action).toBe('refuse')
  })

  it('REFUSES a stable target while `latest` still trails on the pre line', () => {
    // The publish step failed or has not run yet. Aligning here would announce
    // a stable on `next` that `latest` does not agree exists.
    const d = decideAction({ latest: '0.5.0', next: '0.6.0-pre.24' }, '0.6.0')
    expect(d.action).toBe('refuse')
  })

  it('ALIGNS only when `latest` is already exactly the target', () => {
    const d = decideAction({ latest: '0.6.0', next: '0.6.0-pre.24' }, '0.6.0')
    expect(d.action).toBe('align')
    expect(d.why).toContain('0.6.0-pre.24 → 0.6.0')
  })

  it('SKIPS an already-aligned package, so a re-run is idempotent', () => {
    expect(decideAction({ latest: '0.6.0', next: '0.6.0' }, '0.6.0').action).toBe('skip')
  })

  it('ALIGNS a package that has no `next` tag yet', () => {
    expect(decideAction({ latest: '0.6.0' }, '0.6.0').action).toBe('align')
  })
})

describe('planAlignment — exclusions are stated, never silent', () => {
  const derived = [
    { pkg: '@noy-db/hub', version: '0.6.0' },
    { pkg: '@noy-db/to-file', version: '0.6.0' },
    { pkg: 'create-noy-db', version: '0.6.0' },
  ]

  it('create-noy-db is a lockstep target like any other member (#1313)', () => {
    // It used to be excluded by name as an "own version line" package. It never
    // meant to be one: the normaliser skipped the unscoped name and the drift
    // broke every scaffolded install. On the line, its `next` is aligned here.
    const { targets, excluded } = planAlignment(derived, '0.6.0')
    expect(targets.map((t) => t.pkg)).toEqual(['@noy-db/hub', '@noy-db/to-file', 'create-noy-db'])
    expect(excluded).toEqual([])
  })

  it('a create-noy-db that fell off the line is a lockstep BREAK, not an exclusion', () => {
    const drifted = [{ pkg: '@noy-db/hub', version: '0.6.0' }, { pkg: 'create-noy-db', version: '0.3.3-pre.23' }]
    const { lockstepBroken, excluded } = planAlignment(drifted, '0.6.0')
    expect(lockstepBroken).toBe(true)
    expect(excluded.find((e) => e.pkg === 'create-noy-db')?.why).toMatch(/^LOCKSTEP/)
  })

  it('treats a lockstep mismatch as an ABORT, not a skip', () => {
    const partial = [
      { pkg: '@noy-db/hub', version: '0.6.0' },
      { pkg: '@noy-db/to-file', version: '0.6.0-pre.24' }, // normalizer did not finish
    ]
    const { lockstepBroken, excluded } = planAlignment(partial, '0.6.0')
    expect(lockstepBroken).toBe(true)
    expect(excluded[0]!.why).toMatch(/LOCKSTEP VIOLATION/)
  })

  it('a fully normalized line is not broken', () => {
    expect(planAlignment(derived, '0.6.0').lockstepBroken).toBe(false)
  })

  it('OWN_VERSION_LINE is exported so the exclusion is auditable — and empty since #1313', () => {
    expect(OWN_VERSION_LINE).toEqual([])
  })
})

describe('derivePackages — derived, never hardcoded', () => {
  const fake = (manifests: Record<string, unknown>) => (p: string) => {
    const m = manifests[p.replace(/\\/g, '/')]
    if (!m) throw new Error('ENOENT')
    return m
  }

  it('picks up a brand-new package directory without being told about it', () => {
    // The whole point: a store that debuts tomorrow is included because it is
    // on disk, not because someone remembered to add it to a list.
    const derived = derivePackages(
      'packages',
      fake({
        'packages/hub/package.json': { name: '@noy-db/hub', version: '0.6.0' },
        'packages/to-brand-new/package.json': { name: '@noy-db/to-brand-new', version: '0.6.0' },
      }),
      () => ['hub', 'to-brand-new'],
    )
    expect(derived.map((d) => d.pkg)).toEqual(['@noy-db/hub', '@noy-db/to-brand-new'])
  })

  it('skips private packages and directories with no manifest', () => {
    const derived = derivePackages(
      'packages',
      fake({
        'packages/hub/package.json': { name: '@noy-db/hub', version: '0.6.0' },
        'packages/internal/package.json': { name: '@noy-db/internal', version: '0.6.0', private: true },
      }),
      () => ['hub', 'internal', 'not-a-package'],
    )
    expect(derived.map((d) => d.pkg)).toEqual(['@noy-db/hub'])
  })
})

describe('confirmMoved — a stale read is not a failure', () => {
  const noop = () => {}

  it('accepts a tag that becomes visible on a later attempt', () => {
    // What actually happened on the 0.6.0 cut: every write succeeded and every
    // immediate read-back returned the previous value, so the job reported 52
    // failures and printed 52 OTP repair commands for packages that were
    // already correct. npm's read-after-write is CDN-served and not
    // immediately consistent.
    let call = 0
    const read = () => (++call > 2 ? { next: '0.6.0' } : { next: '0.6.0-pre.24' })
    const pending = confirmMoved(['@noy-db/hub'], '0.6.0', noop, { read, sleep: noop, delayMs: 0 })
    expect(pending).toEqual([])
  })

  it('reports one that never becomes visible — it does not confirm blindly', () => {
    const read = () => ({ next: '0.6.0-pre.24' })
    const pending = confirmMoved(['@noy-db/hub'], '0.6.0', noop, { read, sleep: noop, delayMs: 0, attempts: 2 })
    expect(pending).toEqual(['@noy-db/hub'])
  })

  it('keeps waiting on a read that throws rather than calling it moved', () => {
    const read = () => { throw new Error('ETIMEDOUT') }
    expect(confirmMoved(['@noy-db/hub'], '0.6.0', noop, { read, sleep: noop, delayMs: 0, attempts: 2 }))
      .toEqual(['@noy-db/hub'])
  })

  it('confirms each package independently — one straggler does not hold the rest', () => {
    const seen: Record<string, number> = {}
    const read = (p: string) => {
      seen[p] = (seen[p] ?? 0) + 1
      return { next: p === '@noy-db/slow' && seen[p]! < 3 ? '0.6.0-pre.24' : '0.6.0' }
    }
    const pending = confirmMoved(['@noy-db/hub', '@noy-db/slow'], '0.6.0', noop, { read, sleep: noop, delayMs: 0 })
    expect(pending).toEqual([])
    expect(seen['@noy-db/hub']).toBe(1) // confirmed first pass, never re-read
  })

  it('does nothing when nothing was written', () => {
    const read = () => { throw new Error('should not be called') }
    expect(confirmMoved([], '0.6.0', noop, { read, sleep: noop })).toEqual([])
  })
})

describe('confirmMoved — the ordering that gives the tail its settle', () => {
  it('reads in the order written, so the last-written is not read first', () => {
    // Load-bearing and unstated until now: same-order reads give every package
    // roughly one pass-duration of settle. Reversing the read loop takes the
    // last-written packages to near-zero, which is where a stale read looks
    // most like a genuine straggler.
    const order: string[] = []
    const read = (p: string) => { order.push(p); return { next: '0.6.0' } }
    confirmMoved(['a', 'b', 'c'], '0.6.0', () => {}, { read, sleep: () => {}, delayMs: 0 })
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('re-checks stragglers in their original relative order too', () => {
    const order: string[] = []
    let round = 0
    const read = (p: string) => {
      order.push(p)
      return { next: round++ < 3 ? '0.6.0-pre.24' : '0.6.0' }
    }
    confirmMoved(['a', 'b', 'c'], '0.6.0', () => {}, { read, sleep: () => {}, delayMs: 0 })
    expect(order.slice(0, 3)).toEqual(['a', 'b', 'c'])
    expect(order.slice(3, 6)).toEqual(['a', 'b', 'c'])
  })
})

// ── #1305: own-line packages align against THEIR OWN tags ──────────────────
//
// `OWN_VERSION_LINE` excluded create-noy-db from the lockstep alignment, and
// nothing else was told to touch it — so every stable cut left its `next`
// (0.3.4-pre.17) below its `latest` (0.3.4). The invariant is over the
// OUTPUT: no published package ends a release with `next` sorting below
// `latest`. Computed per package from its own registry tags, never from the
// lockstep `--version`. The list is empty since #1313 (create-noy-db rides
// the line); the decision stays pure and tested for the day a package
// genuinely declares its own line.
import { decideOwnLineAction } from '../align-next-to-stable.mjs'

describe('decideOwnLineAction — the own-line invariant (#1305)', () => {
  it('ALIGNS `next` up to `latest` when a stable cut left it on an older prerelease — the 0.7.0 case', () => {
    const d = decideOwnLineAction({ latest: '0.3.4', next: '0.3.4-pre.17' })
    expect(d).toMatchObject({ action: 'align', version: '0.3.4' })
    expect(d.why).toMatch(/0\.3\.4-pre\.17.*0\.3\.4/)
  })

  it('ALIGNS when `next` is missing entirely — an absent tag is a lying tag too', () => {
    expect(decideOwnLineAction({ latest: '0.3.4' })).toMatchObject({ action: 'align', version: '0.3.4' })
  })

  it('SKIPS when `next` already equals `latest`', () => {
    expect(decideOwnLineAction({ latest: '0.3.4', next: '0.3.4' }).action).toBe('skip')
  })

  it('SKIPS when `next` is AHEAD of `latest` — the normal in-flight state must not be dragged back', () => {
    expect(decideOwnLineAction({ latest: '0.3.4', next: '0.3.5-pre.0' }).action).toBe('skip')
    expect(decideOwnLineAction({ latest: '0.3.4', next: '0.4.0' }).action).toBe('skip')
  })

  it('SKIPS when there is no `latest` — nothing stable to align onto', () => {
    expect(decideOwnLineAction({ next: '0.3.4-pre.17' }).action).toBe('skip')
  })

  it('SKIPS when `latest` is itself a prerelease — that is a different lie, not this one', () => {
    expect(decideOwnLineAction({ latest: '0.3.4-pre.17', next: '0.3.4-pre.16' }).action).toBe('skip')
  })

  it('never names the lockstep version: the decision takes only the package\'s tags', () => {
    expect(decideOwnLineAction.length).toBe(1)
  })
})
