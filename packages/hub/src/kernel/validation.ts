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
   * ⚠️ Also supply `suggestion` on a rejection (#1430). Because this
   * knob replaces every default rule, the hub's built-in remediation
   * copy no longer describes anything true about your vault — so it is
   * deliberately NOT used here. Omitting `suggestion` yields a bare
   * `Weak secret (<reason>).`, which is less helpful but never wrong.
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
      /**
       * Remediation copy for THIS failure, overriding the hub's built-in
       * `SUGGESTIONS` map (#1430).
       *
       * Only a {@link SecretPolicy.customValidator} has any business
       * setting it: the built-in copy describes the hub's default rules
       * ("lowercase letters and single spaces", "at least 6 words"), and
       * a vault that replaced those rules gets advice contradicting the
       * format it actually accepts. Supply the copy your rules justify —
       * and note that a validator returning no `suggestion` produces a
       * bare `Weak secret (<reason>).` rather than false advice.
       */
      readonly suggestion?: string
    }

/**
 * Thrown by `assertStrongSecret()` and by every hub ingress
 * point (`createOwnerKeyring`, `grant`, `rotateSecret`) when a
 * supplied phrase fails the structural rules above.
 */
export class WeakSecretError extends NoydbError {
  readonly reason: WeakSecretReason
  /**
   * Remediation copy. Empty string when no truthful advice was
   * available — a `customValidator` rejected the phrase and supplied
   * none, so the hub has no rules to describe (#1430). Never populated
   * with the built-in copy in that case: wrong advice is worse than
   * none, especially for a vault whose own credentials violate it.
   */
  readonly suggestion: string
  constructor(reason: WeakSecretReason, suggestion?: string) {
    const advice = suggestion ?? ''
    super('WEAK_SECRET', advice ? `Weak secret (${reason}). ${advice}` : `Weak secret (${reason}).`)
    this.name = 'WeakSecretError'
    this.reason = reason
    this.suggestion = advice
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
/**
 * Pick the remediation copy for a failed check (#1430).
 *
 * The built-in `SUGGESTIONS` map describes the hub's DEFAULT rules. A
 * `customValidator` replaces those rules wholesale, so quoting the map
 * then tells the user to do something the vault will reject — the
 * reported case was a vault accepting `ann-saraphia1-2026`-shaped
 * phrases being advised "no digits, no punctuation, six English words".
 * The rejection was right and the advice was the opposite of the truth.
 *
 * Precedence: the validator's own copy, else nothing when a validator
 * owns the rules, else the built-in map. Same rationale as
 * {@link promptSuggestion}, which already overrides the map where it
 * would misdirect.
 */
function resolveSuggestion(
  result: Extract<SecretValidationResult, { ok: false }>,
  customValidatorInUse: boolean,
): string | undefined {
  if (result.suggestion !== undefined) return result.suggestion
  if (customValidatorInUse) return undefined
  return SUGGESTIONS[result.reason]
}

export function assertStrongSecret(
  s: string,
  opts?: SecretPolicy & { allowWeakSecret?: boolean },
): void {
  if (opts?.allowWeakSecret) return
  const result = validateSecret(s, opts)
  if (result.ok) return
  throw new WeakSecretError(
    result.reason,
    resolveSuggestion(result, opts?.customValidator !== undefined),
  )
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
/**
 * Default per-word character floor for echo-mode validation (prompt AND
 * combined checks). Relaxed to 1 from the standard 3-char floor
 * ({@link DEFAULT_MIN_WORD_LENGTH}) — echo secrets are natural-language
 * sentences (spec #940's canonical example is Italian), and Romance
 * languages are full of 2-letter function words ("mi", "da", "al") that
 * the standard floor would otherwise reject even though the combined
 * secret is plenty strong. Word-COUNT floors (prompt 3, combined 6) are
 * unchanged — this only relaxes per-word length.
 */
export const DEFAULT_ECHO_MIN_WORD_LENGTH = 1

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
    minWordLength: opts?.prompt?.minWordLength ?? DEFAULT_ECHO_MIN_WORD_LENGTH,
    ...(opts?.prompt?.rejectRepeatedAdjacent !== undefined
      && { rejectRepeatedAdjacent: opts.prompt.rejectRepeatedAdjacent }),
    ...(opts?.prompt?.pattern !== undefined && { pattern: opts.prompt.pattern }),
    ...(opts?.prompt?.customValidator !== undefined && { customValidator: opts.prompt.customValidator }),
  }
  const promptResult = validateSecret(parts.prompt, promptPolicy)
  if (!promptResult.ok) return { result: promptResult, failedCheck: 'prompt' }
  // Same field-by-field construction as promptPolicy above (not a spread of
  // `opts?.combined`) so the combined check's minWordLength defaults to the
  // echo floor too, while minWords keeps the standard whole-secret default
  // (6) when the caller doesn't override it.
  const combinedPolicy: SecretPolicy = {
    ...(opts?.combined?.minWords !== undefined && { minWords: opts.combined.minWords }),
    minWordLength: opts?.combined?.minWordLength ?? DEFAULT_ECHO_MIN_WORD_LENGTH,
    ...(opts?.combined?.rejectRepeatedAdjacent !== undefined
      && { rejectRepeatedAdjacent: opts.combined.rejectRepeatedAdjacent }),
    ...(opts?.combined?.pattern !== undefined && { pattern: opts.combined.pattern }),
    ...(opts?.combined?.customValidator !== undefined && { customValidator: opts.combined.customValidator }),
  }
  const combinedResult = validateSecret(`${parts.prompt} ${parts.echo} ${parts.key}`, combinedPolicy)
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
  // #1430 — a validator-supplied suggestion outranks both the prompt copy
  // and the map, and the half that failed decides which validator is the
  // one that owns the rules here.
  const customInUse = failedCheck === 'prompt'
    ? opts?.prompt?.customValidator !== undefined
    : opts?.combined?.customValidator !== undefined
  const suggestion = result.suggestion !== undefined
    ? result.suggestion
    : failedCheck === 'prompt' && !customInUse
      ? promptSuggestion(result.reason, promptMinWords)
      : resolveSuggestion(result, customInUse)

  throw new WeakSecretError(result.reason, suggestion)
}
