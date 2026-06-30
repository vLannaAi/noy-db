import { describe, it, expect } from 'vitest'
import { extractSnippet } from '../src/with-lookup/search/snippet.js'

describe('extractSnippet (#308 L1)', () => {
  it('returns the whole text when shorter than the window', () => {
    expect(extractSnippet('short text', 0, 80)).toBe('short text')
  })

  it('windows around the offset and marks truncation', () => {
    const text = 'x'.repeat(200) + 'TARGET' + 'y'.repeat(200)
    const snip = extractSnippet(text, 200, 20)
    expect(snip).toContain('TARGET')
    expect(snip.startsWith('…')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
    expect(Array.from(snip).length).toBeLessThanOrEqual(20 + 6) // window + a few chars + ellipses
  })

  it('is unicode-safe (does not split Thai/emoji code points)', () => {
    const text = 'ก'.repeat(50) + 'เป้าหมาย' + 'ข'.repeat(50)
    const snip = extractSnippet(text, 50, 16)
    expect(snip).toContain('เป้าหมาย')
  })
})
