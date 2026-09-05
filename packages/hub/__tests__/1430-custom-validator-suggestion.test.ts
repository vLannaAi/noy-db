/**
 * #1430 — remediation copy must describe the rules the vault actually
 * applies.
 *
 * `SUGGESTIONS` is a fixed map keyed on `reason`, describing the hub's
 * DEFAULT rules ("lowercase letters and single spaces", "at least 6
 * words"). A `customValidator` replaces every one of those rules, so
 * quoting the map afterwards advises the opposite of the truth: the
 * reported vault accepts `ann-saraphia1-2026`-shaped phrases and its
 * users were told to use no digits, no punctuation, and six English
 * words. The rejection was correct; only the advice was wrong.
 *
 * Precedence pinned here: validator-supplied copy > nothing (when a
 * validator owns the rules) > the built-in map.
 */
import { describe, it, expect } from 'vitest'
import {
  assertStrongSecret,
  assertStrongEchoSecret,
  WeakSecretError,
} from '../src/kernel/validation.js'
import type { SecretValidationResult } from '../src/kernel/validation.js'

/** Stands in for the reported vault: ≥3 tokens, digits and hyphens fine. */
const houseRules = (phrase: string): SecretValidationResult => {
  const tokens = phrase.split(/[- ]/).filter(Boolean)
  if (tokens.length >= 3) return { ok: true, words: tokens.length }
  return { ok: false, reason: 'too-few-words', minimum: 3, got: tokens.length }
}

const withAdvice = (phrase: string): SecretValidationResult => {
  const r = houseRules(phrase)
  return r.ok ? r : { ...r, suggestion: 'Use at least 3 parts, e.g. "ann-saraphia1-2026".' }
}

function thrown(fn: () => void): WeakSecretError {
  try {
    fn()
  } catch (err) {
    if (err instanceof WeakSecretError) return err
    throw err
  }
  throw new Error('expected WeakSecretError')
}

describe('#1430 — WeakSecretError remediation under a customValidator', () => {
  it('never quotes the built-in copy when a customValidator owns the rules', () => {
    const err = thrown(() => assertStrongSecret('abc', { customValidator: houseRules }))

    expect(err.reason).toBe('too-few-words')
    // The exact strings the reported vault contradicts.
    expect(err.message).not.toMatch(/lowercase/i)
    expect(err.message).not.toMatch(/6 words/)
    expect(err.message).not.toMatch(/correct horse battery staple/)
    // Bare, and well-formed — no dangling separator from the empty advice.
    expect(err.message).toBe('Weak secret (too-few-words).')
    expect(err.suggestion).toBe('')
  })

  it('prefers the validator’s own copy when it supplies one', () => {
    const err = thrown(() => assertStrongSecret('abc', { customValidator: withAdvice }))

    expect(err.suggestion).toBe('Use at least 3 parts, e.g. "ann-saraphia1-2026".')
    expect(err.message).toBe(
      'Weak secret (too-few-words). Use at least 3 parts, e.g. "ann-saraphia1-2026".',
    )
  })

  it('leaves the default path untouched — the built-in copy still ships', () => {
    const err = thrown(() => assertStrongSecret('one two'))

    expect(err.reason).toBe('too-few-words')
    expect(err.suggestion).toMatch(/at least 6 words/)
    expect(err.message).toMatch(/correct horse battery staple printer toaster/)
  })

  it('still accepts a phrase the custom rules allow', () => {
    expect(() =>
      assertStrongSecret('ann-saraphia1-2026', { customValidator: houseRules }),
    ).not.toThrow()
  })

  it('drops the prompt-specific copy too when the prompt has its own validator (echo path)', () => {
    const parts = { prompt: 'abc', echo: 'x', key: 'k' }
    const err = thrown(() =>
      assertStrongEchoSecret(parts, { prompt: { customValidator: houseRules } }),
    )

    expect(err.message).toBe('Weak secret (too-few-words).')
    // `promptSuggestion`'s copy is as wrong here as the map's.
    expect(err.message).not.toMatch(/the part you type first/)
  })

  it('keeps the prompt-specific copy when no validator replaced the prompt rules', () => {
    const parts = { prompt: 'abc', echo: 'x', key: 'k' }
    const err = thrown(() => assertStrongEchoSecret(parts))

    expect(err.message).toMatch(/the part you type first/)
  })
})
