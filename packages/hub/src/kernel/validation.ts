/**
 * Secret validation — phrase format (per the three-tier session-tiers
 * design, locked 2026-05-04).
 *
 * Secrets are **phrases**: multiple simple words, easy to remember,
 * structurally constrained so a weak choice cannot silently collapse the
 * security floor. The format is intentionally narrow: lowercase letters
 * and single spaces only, no punctuation, no symbols, no digits.
 *
 * - Default minimum: 6 words (~77 bits with the 7,776-word EFF list).
 * - Strict minimum: 8 words (~103 bits).
 * - Per-word minimum: 3 characters (excludes "a", "is", "of").
 * - Adjacent repeats rejected ("the the").
 *
 * The hub runs validation default-on at every secret ingress
 * (`createOwnerKeyring`, `grant`, `rotateSecret`); test fixtures and
 * CLI scripts override via `{ allowWeakSecret: true }`.
 *
 * @module
 */
import { NoydbError, ValidationError } from './errors.js'

/** All reasons a phrase can be rejected. */
export type WeakSecretReason =
  | 'empty'
  | 'invalid-chars'
  | 'leading-or-trailing-space'
  | 'double-space'
  | 'too-few-words'
  | 'word-too-short'
  | 'repeated-adjacent'

/** Per-vault knobs. Aligns with `VaultPolicy.secret`. */
export interface SecretPolicy {
  /** Minimum number of words. Default 6. Strict policy uses 8. */
  readonly minWords?: number
  /** Minimum characters per word. Default 3. */
  readonly minWordLength?: number
  /** Reject adjacent identical words ("the the"). Default true. */
  readonly rejectRepeatedAdjacent?: boolean
  /**
   * Override the default character-class rule (`/^[a-z]+( [a-z]+)*$/`).
   *
   * The hub's strict default is lowercase-letters-and-single-spaces
   * because that's what the EFF wordlist generator emits and what
   * most attacker password lists are keyed on. Use this knob to allow
   * digits, uppercase, hyphens, or non-Latin scripts when the
   * consumer's audience needs them — e.g.:
   *
   * ```ts
   * // Thai + English mix with digits permitted
   * pattern: /^[\p{L}0-9 ]+( [\p{L}0-9 ]+)*$/u
   *
   * // Allow uppercase + hyphens (secret-with-hyphens style)
   * pattern: /^[A-Za-z]+([- ][A-Za-z]+)*$/
   * ```
   *
   * The OTHER structural rules still apply (min-words split by space,
   * min-word-length, repeated-adjacent, leading/trailing whitespace,
   * double-space). For non-space-delimited word semantics, use
   * {@link customValidator} instead.
   *
   */
  readonly pattern?: RegExp
  /**
   * Replace ALL validation entirely with a custom function. When set,
   * none of the other SecretPolicy fields apply — the consumer
   * owns every rule (word splitting, character classes, entropy
   * thresholds, allowlist/denylist). Use sparingly; this is the
   * escape hatch for domain-specific phrase formats:
   *
   *   - Localized wordlists with non-space word boundaries
   *   - BIP-39 seed phrases (24 words, fixed wordlist, etc.)
   *   - Organization-specific HR password policies
   *
   * The returned `SecretValidationResult` is what
   * {@link assertStrongSecret} dispatches on — `ok: true` accepts;
   * `ok: false` throws `WeakSecretError` with the supplied reason.
   *
   */
  readonly customValidator?: (phrase: string) => SecretValidationResult
}

/** Result of a check. Discriminated union — compile-time exhaustive. */
export type SecretValidationResult =
  | { readonly ok: true; readonly words: number }
  | {
      readonly ok: false
      readonly reason: WeakSecretReason
      readonly minimum?: number
      readonly got?: number
    }

/**
 * Thrown by `assertStrongSecret()` and by every hub ingress
 * point (`createOwnerKeyring`, `grant`, `rotateSecret`) when a
 * supplied phrase fails the structural rules above.
 */
export class WeakSecretError extends NoydbError {
  readonly reason: WeakSecretReason
  readonly suggestion: string
  constructor(reason: WeakSecretReason, suggestion: string) {
    super('WEAK_SECRET', `Weak secret (${reason}). ${suggestion}`)
    this.name = 'WeakSecretError'
    this.reason = reason
    this.suggestion = suggestion
  }
}

const DEFAULT_MIN_WORDS = 6
const DEFAULT_MIN_WORD_LENGTH = 3

const SUGGESTIONS: Record<WeakSecretReason, string> = {
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
 * result to {@link assertStrongSecret} for the throwing flavour.
 */
export function validateSecret(
  s: string,
  opts?: SecretPolicy,
): SecretValidationResult {
  // Escape hatch: customValidator owns the entire decision. None of
  // the structural rules below run when this is set — the consumer is
  // responsible for the full validation contract.
  if (opts?.customValidator) {
    return opts.customValidator(s)
  }

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

  // The default character class is lowercase-letters-and-spaces;
  // consumers can override via SecretPolicy.pattern (e.g. to
  // allow digits, uppercase, or non-Latin scripts). Word splitting
  // below remains space-based — for non-space word semantics the
  // consumer should use customValidator instead.
  const charPattern = opts?.pattern ?? /^[a-z]+( [a-z]+)*$/
  if (!charPattern.test(s)) {
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
 * Throw {@link WeakSecretError} when the phrase fails. Used by
 * `createOwnerKeyring`, `grant`, and `rotateSecret` at ingress.
 *
 * Pass `{ allowWeakSecret: true }` to bypass — intended for test
 * fixtures, CLI scripts, and dev environments. The override never
 * loosens the cryptographic key derivation; it only relaxes the
 * structural-strength gate.
 */
export function assertStrongSecret(
  s: string,
  opts?: SecretPolicy & { allowWeakSecret?: boolean },
): void {
  if (opts?.allowWeakSecret) return
  const result = validateSecret(s, opts)
  if (result.ok) return
  throw new WeakSecretError(result.reason, SUGGESTIONS[result.reason])
}

/**
 * Estimate the entropy of a phrase, given the EFF 7,776-word list as
 * the assumed wordlist. ~12.9 bits per word.
 *
 * Returns 0 for any input that fails the phrase format — character-class
 * estimates aren't comparable to phrase entropy, and surfacing 0 makes
 * weak inputs visible in any UI that displays an entropy meter.
 */
export function estimateEntropy(secret: string): number {
  const result = validateSecret(secret)
  if (!result.ok) return 0
  return Math.round(result.words * Math.log2(7776))
}

/**
 * Internal compatibility shim. Older code paths used the throwing
 * `validateSecret(s)` directly; some still do via re-exports. Routes
 * to the new `assertStrongSecret` so the contract holds for both
 * shapes during the transition. New code should call
 * {@link assertStrongSecret} directly.
 *
 * @internal
 */
export function legacyAssertSecret(s: string): void {
  try {
    assertStrongSecret(s)
  } catch (err) {
    if (err instanceof WeakSecretError) {
      throw new ValidationError(err.message)
    }
    throw err
  }
}

/** Dedicated floors for the echo mode's three parts (spec resolved Q1/Q5). */
export interface EchoSecretPolicy {
  /** Floor for the typed prompt — the brute-forceable-in-isolation part. */
  readonly prompt?: SecretPolicy
  /** Policy for the combined parts (defaults to the standard whole-secret rules). */
  readonly combined?: SecretPolicy
}

export const DEFAULT_ECHO_PROMPT_MIN_WORDS = 3

/** Which of `validateEchoSecret`'s three internal checks produced a result. */
type EchoSecretCheck = 'empty' | 'prompt' | 'combined'

/**
 * `validateEchoSecret` plus which check produced the result — lets
 * `assertStrongEchoSecret` pick the prompt-specific suggestion without
 * re-running `validateSecret` on the failure path. Internal: NOT
 * package-exported (the public `validateEchoSecret`/`SecretValidationResult`
 * contract stays exactly as before).
 */
function validateEchoSecretDetailed(
  parts: { readonly prompt: string; readonly echo: string; readonly key: string },
  opts?: EchoSecretPolicy,
): { readonly result: SecretValidationResult; readonly failedCheck: EchoSecretCheck } {
  // Trimmed: a whitespace-only part carries no secret material, so it is
  // 'empty' rather than a confusing spacing complaint.
  for (const part of [parts.prompt, parts.echo, parts.key]) {
    if (part.trim().length === 0) return { result: { ok: false, reason: 'empty' }, failedCheck: 'empty' }
  }
  // Field-by-field construction (not a spread of `opts?.prompt`) so an
  // explicit `{ prompt: { minWords: undefined } }` override falls back to
  // the ECHO prompt default (3) rather than reintroducing `undefined` as
  // an own property that would then hit `validateSecret`'s STANDARD
  // default (6) — a spread copies an explicit-`undefined` key verbatim and
  // clobbers the default set here. Each optional field is included only
  // when actually set (`exactOptionalPropertyTypes`).
  const promptPolicy: SecretPolicy = {
    minWords: opts?.prompt?.minWords ?? DEFAULT_ECHO_PROMPT_MIN_WORDS,
    ...(opts?.prompt?.minWordLength !== undefined && { minWordLength: opts.prompt.minWordLength }),
    ...(opts?.prompt?.rejectRepeatedAdjacent !== undefined
      && { rejectRepeatedAdjacent: opts.prompt.rejectRepeatedAdjacent }),
    ...(opts?.prompt?.pattern !== undefined && { pattern: opts.prompt.pattern }),
    ...(opts?.prompt?.customValidator !== undefined && { customValidator: opts.prompt.customValidator }),
  }
  const promptResult = validateSecret(parts.prompt, promptPolicy)
  if (!promptResult.ok) return { result: promptResult, failedCheck: 'prompt' }
  const combinedResult = validateSecret(`${parts.prompt} ${parts.echo} ${parts.key}`, opts?.combined)
  return { result: combinedResult, failedCheck: 'combined' }
}

/** Validate a 3-part echo secret. Never throws. */
export function validateEchoSecret(
  parts: { readonly prompt: string; readonly echo: string; readonly key: string },
  opts?: EchoSecretPolicy,
): SecretValidationResult {
  return validateEchoSecretDetailed(parts, opts).result
}

/**
 * Suggestion copy for a failure that came from the PROMPT's dedicated floor.
 * The generic `SUGGESTIONS` copy quotes the 6-word whole-secret floor, which
 * misdirects an owner whose prompt only has to clear 3 words.
 */
function promptSuggestion(reason: WeakSecretReason, minWords: number): string {
  if (reason === 'too-few-words') {
    return `The prompt (the part you type first) must be at least ${minWords} words. Example: "sono chiamato vicio".`
  }
  return `The prompt (the part you type first) is the problem. ${SUGGESTIONS[reason]}`
}

/** Throwing form of {@link validateEchoSecret}. */
export function assertStrongEchoSecret(
  parts: { readonly prompt: string; readonly echo: string; readonly key: string },
  opts?: EchoSecretPolicy & { allowWeakSecret?: boolean },
): void {
  if (opts?.allowWeakSecret) return
  const { result, failedCheck } = validateEchoSecretDetailed(parts, opts)
  if (result.ok) return

  const promptMinWords = opts?.prompt?.minWords ?? DEFAULT_ECHO_PROMPT_MIN_WORDS
  const suggestion = failedCheck === 'prompt'
    ? promptSuggestion(result.reason, promptMinWords)
    : SUGGESTIONS[result.reason]

  throw new WeakSecretError(result.reason, suggestion)
}
