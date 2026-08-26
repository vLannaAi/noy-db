import { describe, it, expect } from 'vitest'
import { assertCanonicalAdvanced } from '../release/version-advanced.mjs'

/**
 * #1230 — `release:version` must not produce a no-op release.
 *
 * The canonical lockstep version is read from hub AFTER `changeset version`.
 * When no pending changeset targets hub, hub does not bump, so the canonical
 * version is hub's UNCHANGED — already published — version, and the normalizer
 * then drags the legitimately-bumped satellite back down to it. Exit 0, tidy
 * uniform output, changesets consumed, nothing releasable.
 *
 * Asserted on the OUTPUT the script exists to produce — the canonical version
 * ADVANCED — rather than on the input that happened to expose it (a release
 * with no hub changeset).
 */
describe('assertCanonicalAdvanced (#1230)', () => {
  it('accepts a version that advanced', () => {
    expect(() => assertCanonicalAdvanced('0.7.0-pre.6', '0.7.0-pre.7')).not.toThrow()
    expect(() => assertCanonicalAdvanced('0.7.0-pre.6', '0.8.0')).not.toThrow()
  })

  it('REFUSES an unchanged version — the #1230 case', () => {
    expect(() => assertCanonicalAdvanced('0.7.0-pre.6', '0.7.0-pre.6')).toThrow(/did not advance/i)
  })

  it('names both versions, so the message is actionable', () => {
    expect(() => assertCanonicalAdvanced('0.7.0-pre.6', '0.7.0-pre.6'))
      .toThrow(/0\.7\.0-pre\.6/)
  })

  it('explains the likely cause rather than only the symptom', () => {
    // The failure is opaque without it: the engineer sees a correct-looking
    // run and has no reason to suspect which changeset was missing.
    expect(() => assertCanonicalAdvanced('0.7.0-pre.6', '0.7.0-pre.6'))
      .toThrow(/hub/i)
  })

  it('REFUSES a version that went backwards', () => {
    expect(() => assertCanonicalAdvanced('0.7.0-pre.6', '0.7.0-pre.5')).toThrow(/did not advance/i)
  })

  it('refuses an unreadable before-version rather than passing silently', () => {
    // A missing baseline must not be treated as "advanced" — that would make
    // the guard vacuous in exactly the situation it exists for.
    expect(() => assertCanonicalAdvanced(undefined as unknown as string, '0.7.0-pre.7')).toThrow()
  })
})

import { nextLineVersion } from '../release/version-advanced.mjs'

/**
 * The other half of #1230: the guard REFUSES a no-op, but a satellite-only
 * release still has to be possible. Lockstep means a release IS a line move —
 * every package ships on one version — so when hub carries no changeset the
 * line must advance anyway rather than the release being impossible.
 */
describe('nextLineVersion (#1230)', () => {
  it('advances a prerelease counter', () => {
    expect(nextLineVersion('0.7.0-pre.6')).toBe('0.7.0-pre.7')
    expect(nextLineVersion('0.7.0-pre.0')).toBe('0.7.0-pre.1')
    expect(nextLineVersion('1.2.3-rc.9')).toBe('1.2.3-rc.10')
  })

  it('REFUSES to guess a stable bump', () => {
    // Patch vs minor is a judgement about the change, not arithmetic. Guessing
    // it would silently pick a semantic the author never chose.
    expect(() => nextLineVersion('0.7.0')).toThrow(/stable/i)
  })

  it('refuses a malformed version rather than producing a plausible one', () => {
    expect(() => nextLineVersion('not-a-version')).toThrow()
    expect(() => nextLineVersion('0.7.0-pre.abc')).toThrow()
  })

  it('the result always satisfies the advance guard', () => {
    // The two halves must agree: whatever this produces must pass the check
    // that refuses a no-op. Ties them together rather than trusting they match.
    for (const v of ['0.7.0-pre.6', '0.7.0-pre.0', '1.2.3-rc.9']) {
      expect(() => assertCanonicalAdvanced(v, nextLineVersion(v))).not.toThrow()
    }
  })
})

import { changesetWroteASection } from '../release/version-advanced.mjs'

/**
 * #1230, third part — found by the line-advance corrupting hub's CHANGELOG.
 *
 * The heading rewriter maps `## <before>` to `## <after>` for every package the
 * normalizer corrected. That is only sound when `before` names a section
 * `changeset version` JUST WROTE. For a package with no changeset, `before` is
 * the heading of the PREVIOUSLY PUBLISHED section — so rewriting it RENAMES a
 * released entry. Caught when hub's `## 0.7.0-pre.6` became `## 0.7.0-pre.7`
 * while pre.6 was already on npm.
 */
describe('changesetWroteASection (#1230)', () => {
  it('true when changeset version moved the package', () => {
    // changesets bumped it (0.7.0-pre.6 -> 1.0.0 via the pre-1.0 heuristic),
    // so `## 1.0.0` is a new section and rewriting its heading is correct.
    expect(changesetWroteASection('0.7.0-pre.6', '1.0.0')).toBe(true)
  })

  it('FALSE when changeset version left the package alone', () => {
    // No changeset targeted it. Its topmost heading is the last RELEASED one;
    // rewriting that renames published history.
    expect(changesetWroteASection('0.7.0-pre.6', '0.7.0-pre.6')).toBe(false)
  })
})
