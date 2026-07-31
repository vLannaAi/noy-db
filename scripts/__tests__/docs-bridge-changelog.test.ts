import { describe, it, expect } from 'vitest'
import { extractSection } from '../docs-bridge/changelog.mjs'

const CHANGELOG = `# @noy-db/to-memory

## 0.4.0-pre.11

### Patch Changes

- fixed the clock

## 0.4.0

- the stable one
`

describe('extractSection', () => {
  it('returns the section body verbatim, without the heading', () => {
    expect(extractSection(CHANGELOG, '0.4.0-pre.11')).toBe(
      '### Patch Changes\n\n- fixed the clock',
    )
  })

  it('stops at the next version heading', () => {
    expect(extractSection(CHANGELOG, '0.4.0')).toBe('- the stable one')
  })

  it('returns null when the version has no section', () => {
    expect(extractSection(CHANGELOG, '0.4.0-pre.10')).toBeNull()
  })

  it('matches the version exactly — a stable tag must not match its prerelease', () => {
    // `## 0.4.0` must not be found by a prefix scan for `0.4.0-pre.11`, and
    // vice versa. Getting this wrong mislabels a version-only release.
    const onlyPre = '# x\n\n## 0.4.0-pre.11\n\n- pre only\n'
    expect(extractSection(onlyPre, '0.4.0')).toBeNull()
  })
})
