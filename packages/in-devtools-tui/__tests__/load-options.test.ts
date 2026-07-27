import { describe, it, expect } from 'vitest'
import { resolveSecret } from '../src/load-options.js'

describe('resolveSecret', () => {
  it('prefers --secret=… from argv', () => {
    expect(resolveSecret(['--secret=hunter2'], {})).toBe('hunter2')
  })
  it('falls back to NOYDB_SECRET env', () => {
    expect(resolveSecret([], { NOYDB_SECRET: 'fromenv' })).toBe('fromenv')
  })
  it('returns undefined when neither is given (caller must prompt)', () => {
    expect(resolveSecret([], {})).toBeUndefined()
  })
})
