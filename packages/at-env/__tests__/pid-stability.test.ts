/**
 * pid-stability lock for @noy-db/at-env.
 *
 * Per the at-* sealing dimension foundation doc, §11.9.1:
 *   Once a provider ships v1.x, the `pid` format is semver-frozen.
 *   Changing it is a major-version break of the provider package,
 *   treated with the same discipline as a public API break — because
 *   every existing sealed envelope on disk references the pid as its
 *   dispatch key.
 *
 * This file locks at-env's pid format with golden-string assertions.
 * If anyone changes the format (e.g., from `env:` to `at-env:`), this
 * test fails — forcing a deliberate version-bump conversation rather
 * than an accidental break.
 *
 * Format (frozen as of pre.14 / @noy-db/at-env 0.1.0):
 *   env:<envVar>
 *
 * Examples:
 *   env:NOYDB_SEALING_KEY  (default envVar)
 *   env:MY_CUSTOM_KEY      (custom envVar)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { envSealingProvider } from '../src/index.js'

// 32 bytes of arbitrary but stable test material, base64-encoded.
const TEST_KEY_BASE64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

describe('@noy-db/at-env — pid format stability (§11.9.1)', () => {
  // Track which env vars we've set so we can clean them up regardless
  // of which test branch ran.
  const setVars: string[] = []
  beforeEach(() => { setVars.length = 0 })
  afterEach(() => { for (const v of setVars) delete process.env[v] })

  function setEnv(name: string, value: string) {
    process.env[name] = value
    setVars.push(name)
  }

  it('produces the locked `env:NOYDB_SEALING_KEY` id with default envVar', () => {
    setEnv('NOYDB_SEALING_KEY', TEST_KEY_BASE64)
    const p = envSealingProvider()
    expect(p.id).toBe('env:NOYDB_SEALING_KEY')
  })

  it('produces the locked `env:<envVar>` id with custom envVar', () => {
    setEnv('MY_CUSTOM_KEY', TEST_KEY_BASE64)
    const p = envSealingProvider({ envVar: 'MY_CUSTOM_KEY' })
    expect(p.id).toBe('env:MY_CUSTOM_KEY')
  })

  it('preserves envVar case verbatim (no normalization)', () => {
    setEnv('CamelCase_Key', TEST_KEY_BASE64)
    const p = envSealingProvider({ envVar: 'CamelCase_Key' })
    expect(p.id).toBe('env:CamelCase_Key')
  })

  it('does not include a version suffix in the pid', () => {
    setEnv('NOYDB_SEALING_KEY', TEST_KEY_BASE64)
    const p = envSealingProvider()
    // The pid identifies the env-var-class binding, not a key version.
    // KMS-style versioned identifiers would belong on a different
    // provider; for at-env the bound-to-env-var contract IS the
    // identity.
    expect(p.id).not.toMatch(/[:/]v\d+$/)
  })

  it('starts with the `env:` family prefix exactly', () => {
    setEnv('NOYDB_SEALING_KEY', TEST_KEY_BASE64)
    const p = envSealingProvider()
    expect(p.id.startsWith('env:')).toBe(true)
    // Guard against accidental rebranding to e.g. `at-env:` or `env-var:`.
    expect(p.id).not.toMatch(/^at-env:|^env-var:|^envvar:/i)
  })
})
