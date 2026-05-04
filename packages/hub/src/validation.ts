/**
 * Passphrase validation — phrase format (per the three-tier session-tiers
 * design, locked 2026-05-04).
 *
 * Passphrases are **phrases**: multiple simple words, easy to remember,
 * structurally constrained so a weak choice cannot silently collapse the
 * security floor. The format is intentionally narrow: lowercase letters
 * and single spaces only, no punctuation, no symbols, no digits.
 *
 * - Default minimum: 6 words (~77 bits with the 7,776-word EFF list).
 * - Strict minimum: 8 words (~103 bits).
 * - Per-word minimum: 3 characters (excludes "a", "is", "of").
 * - Adjacent repeats rejected ("the the").
 *
 * The hub runs validation default-on at every passphrase ingress
 * (`createOwnerKeyring`, `grant`, `rotatePassphrase`); test fixtures and
 * CLI scripts override via `{ allowWeakPassphrase: true }`.
 *
 * @module
 */
import { NoydbError, ValidationError } from './errors.js'

/** All reasons a phrase can be rejected. */
export type WeakPassphraseReason =
  | 'empty'
  | 'invalid-chars'
  | 'leading-or-trailing-space'
  | 'double-space'
  | 'too-few-words'
  | 'word-too-short'
  | 'repeated-adjacent'

/** Per-vault knobs. Aligns with `VaultPolicy.passphrase`. */
export interface PassphrasePolicy {
  /** Minimum number of words. Default 6. Strict policy uses 8. */
  readonly minWords?: number
  /** Minimum characters per word. Default 3. */
  readonly minWordLength?: number
  /** Reject adjacent identical words ("the the"). Default true. */
  readonly rejectRepeatedAdjacent?: boolean
}

/** Result of a check. Discriminated union — compile-time exhaustive. */
export type PassphraseValidationResult =
  | { readonly ok: true; readonly words: number }
  | {
      readonly ok: false
      readonly reason: WeakPassphraseReason
      readonly minimum?: number
      readonly got?: number
    }

/**
 * Thrown by `assertStrongPassphrase()` and by every hub ingress
 * point (`createOwnerKeyring`, `grant`, `rotatePassphrase`) when a
 * supplied phrase fails the structural rules above.
 */
export class WeakPassphraseError extends NoydbError {
  readonly reason: WeakPassphraseReason
  readonly suggestion: string
  constructor(reason: WeakPassphraseReason, suggestion: string) {
    super('WEAK_PASSPHRASE', `Weak passphrase (${reason}). ${suggestion}`)
    this.name = 'WeakPassphraseError'
    this.reason = reason
    this.suggestion = suggestion
  }
}

const DEFAULT_MIN_WORDS = 6
const DEFAULT_MIN_WORD_LENGTH = 3

const SUGGESTIONS: Record<WeakPassphraseReason, string> = {
  empty: 'Provide a phrase of at least 6 lowercase words separated by single spaces.',
  'invalid-chars':
    'Use only lowercase letters [a-z] and single spaces. No punctuation, symbols, digits, or uppercase.',
  'leading-or-trailing-space': 'Trim leading and trailing spaces.',
  'double-space': 'Use exactly one space between words.',
  'too-few-words':
    'Use at least 6 words by default (8 under strict policy). Example: "correct horse battery staple printer toaster".',
  'word-too-short': 'Each word must be at least 3 characters. Drop short fillers like "a", "is", "of".',
  'repeated-adjacent': 'Avoid repeating the same word twice in a row.',
}

/**
 * Inspect a phrase against the format rules and return a structured
 * verdict. Never throws — callers either branch on `ok` or pass the
 * result to {@link assertStrongPassphrase} for the throwing flavour.
 */
export function validatePassphrase(
  s: string,
  opts?: PassphrasePolicy,
): PassphraseValidationResult {
  const minWords = opts?.minWords ?? DEFAULT_MIN_WORDS
  const minWordLength = opts?.minWordLength ?? DEFAULT_MIN_WORD_LENGTH
  const rejectRepeated = opts?.rejectRepeatedAdjacent ?? true

  if (s.length === 0) {
    return { ok: false, reason: 'empty' }
  }

  if (s !== s.trim()) {
    return { ok: false, reason: 'leading-or-trailing-space' }
  }

  if (s.includes('  ')) {
    return { ok: false, reason: 'double-space' }
  }

  if (!/^[a-z]+( [a-z]+)*$/.test(s)) {
    return { ok: false, reason: 'invalid-chars' }
  }

  const words = s.split(' ')

  if (words.length < minWords) {
    return { ok: false, reason: 'too-few-words', minimum: minWords, got: words.length }
  }

  for (const w of words) {
    if (w.length < minWordLength) {
      return { ok: false, reason: 'word-too-short', minimum: minWordLength, got: w.length }
    }
  }

  if (rejectRepeated) {
    for (let i = 1; i < words.length; i++) {
      if (words[i] === words[i - 1]) {
        return { ok: false, reason: 'repeated-adjacent' }
      }
    }
  }

  return { ok: true, words: words.length }
}

/**
 * Throw {@link WeakPassphraseError} when the phrase fails. Used by
 * `createOwnerKeyring`, `grant`, and `rotatePassphrase` at ingress.
 *
 * Pass `{ allowWeakPassphrase: true }` to bypass — intended for test
 * fixtures, CLI scripts, and dev environments. The override never
 * loosens the cryptographic key derivation; it only relaxes the
 * structural-strength gate.
 */
export function assertStrongPassphrase(
  s: string,
  opts?: PassphrasePolicy & { allowWeakPassphrase?: boolean },
): void {
  if (opts?.allowWeakPassphrase) return
  const result = validatePassphrase(s, opts)
  if (result.ok) return
  throw new WeakPassphraseError(result.reason, SUGGESTIONS[result.reason])
}

/**
 * Estimate the entropy of a phrase, given the EFF 7,776-word list as
 * the assumed wordlist. ~12.9 bits per word.
 *
 * Returns 0 for any input that fails the phrase format — character-class
 * estimates aren't comparable to phrase entropy, and surfacing 0 makes
 * weak inputs visible in any UI that displays an entropy meter.
 */
export function estimateEntropy(passphrase: string): number {
  const result = validatePassphrase(passphrase)
  if (!result.ok) return 0
  return Math.round(result.words * Math.log2(7776))
}

/**
 * Internal compatibility shim. Older code paths used the throwing
 * `validatePassphrase(s)` directly; some still do via re-exports. Routes
 * to the new `assertStrongPassphrase` so the contract holds for both
 * shapes during the transition. New code should call
 * {@link assertStrongPassphrase} directly.
 *
 * @internal
 */
export function legacyAssertPassphrase(s: string): void {
  try {
    assertStrongPassphrase(s)
  } catch (err) {
    if (err instanceof WeakPassphraseError) {
      throw new ValidationError(err.message)
    }
    throw err
  }
}
