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
import { decideAction, planAlignment, derivePackages, OWN_VERSION_LINE } from '../align-next-to-stable.mjs'

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
    { pkg: 'create-noy-db', version: '0.3.3-pre.23' },
  ]

  it('excludes create-noy-db BY NAME, not by its version happening to differ', () => {
    const { targets, excluded } = planAlignment(derived, '0.6.0')
    expect(targets.map((t) => t.pkg)).toEqual(['@noy-db/hub', '@noy-db/to-file'])
    expect(excluded.find((e) => e.pkg === 'create-noy-db')?.why).toMatch(/own version line/)
  })

  it('still excludes it when its version coincidentally matches the target', () => {
    const coincidence = [{ pkg: 'create-noy-db', version: '0.6.0' }]
    const { targets, excluded } = planAlignment(coincidence, '0.6.0')
    expect(targets).toEqual([])
    expect(excluded[0]!.why).toMatch(/own version line/)
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

  it('OWN_VERSION_LINE is exported so the exclusion is auditable', () => {
    expect(OWN_VERSION_LINE).toContain('create-noy-db')
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
