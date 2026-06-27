import { describe, it, expect } from 'vitest'
import { resolvePassphrase } from '../src/load-options.js'

describe('resolvePassphrase', () => {
  it('prefers --passphrase=… from argv', () => {
    expect(resolvePassphrase(['--passphrase=hunter2'], {})).toBe('hunter2')
  })
  it('falls back to NOYDB_PASSPHRASE env', () => {
    expect(resolvePassphrase([], { NOYDB_PASSPHRASE: 'fromenv' })).toBe('fromenv')
  })
  it('returns undefined when neither is given (caller must prompt)', () => {
    expect(resolvePassphrase([], {})).toBeUndefined()
  })
})
