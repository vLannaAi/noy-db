/**
 * **@noy-db/on-threat** — threat-response primitives for noy-db.
 *
 * Three independent, opt-in mechanisms (all of which are pure logic —
 * the caller coordinates persistence and keyring actions):
 *
 *   1. **{@link LockoutPolicy}** (#196) — N wrong passphrases within
 *      a window trigger lockout, cooldown, or wipe. Pure state
 *      machine; caller persists the `LockoutState` between attempts.
 *
 *   2. **{@link checkDuress}** (#197) — compare an entered
 *      passphrase against a stored `duressDigest` to trigger
 *      data-destruct mode. The action itself (DEK purge + keyring
 *      delete) is delegated to a caller-supplied `onDuress` handler;
 *      this package only detects the match.
 *
 *   3. **{@link checkHoneypot}** (#198) — alternate duress
 *      passphrase that surfaces a decoy vault instead of wiping.
 *      Same detection pattern as `checkDuress`, but the caller's
 *      handler routes to the pre-seeded honeypot vault.
 *
 * None of the three mechanisms require server cooperation — everything
 * runs against local state. The combination gives a plausible-deniability
 * model: lockout protects against brute force; duress protects against
 * coercion; honeypot protects against inspection by showing something
 * that survives scrutiny long enough to get to safety.
 *
 * @packageDocumentation
 */

// ─── #196 Lockout policy ────────────────────────────────────────────────

export interface LockoutConfig {
  /** Failed attempts within the window before lockout activates. Default 5. */
  readonly threshold?: number
  /** Window in ms during which attempts accumulate. Default 15 minutes. */
  readonly windowMs?: number
  /** Cooldown in ms after the threshold is hit. Default 5 minutes. */
  readonly cooldownMs?: number
  /**
   * Strikes before terminal action. After this many lockout rounds the
   * state enters `'wipe'`, signalling the caller to destroy the vault.
   * Default 3.
   */
  readonly maxStrikes?: number
}

/**
 * Persistent lockout state. Caller stores this next to the keyring and
 * passes it through every `recordAttempt` / `isLocked` call.
 */
export interface LockoutState {
  /** Count of failed attempts in the current window. */
  failures: number
  /** ISO timestamp of the first failure in the current window. */
  windowStart: string | null
  /** ISO timestamp when the current lockout ends (null when not locked). */
  lockedUntil: string | null
  /** How many rounds of lockout have fired so far. */
  strikes: number
  /** Once the policy decides wipe, this latches to true until explicitly reset. */
  wiped: boolean
}

/** Seed a fresh lockout state for a new keyring. */
export function initialLockoutState(): LockoutState {
  return {
    failures: 0,
    windowStart: null,
    lockedUntil: null,
    strikes: 0,
    wiped: false,
  }
}

export interface AttemptOutcome {
  /** Is the keyring currently locked after recording this failure? */
  readonly locked: boolean
  /** When does the lock expire? */
  readonly unlockAt?: string
  /** Did this failure trip the terminal wipe? Caller must destroy the vault. */
  readonly wipe?: boolean
  /** Remaining failures until the next lockout trip. */
  readonly remainingAttempts?: number
}

/** Record a failed unlock attempt and update `state` in place. */
export function recordFailure(state: LockoutState, config: LockoutConfig = {}): AttemptOutcome {
  const threshold = config.threshold ?? 5
  const windowMs = config.windowMs ?? 15 * 60 * 1000
  const cooldownMs = config.cooldownMs ?? 5 * 60 * 1000
  const maxStrikes = config.maxStrikes ?? 3

  const now = new Date()
  const nowMs = now.getTime()

  // Still inside an active lockout — pass-through.
  if (state.lockedUntil) {
    const unlockMs = new Date(state.lockedUntil).getTime()
    if (nowMs < unlockMs) {
      return { locked: true, unlockAt: state.lockedUntil }
    }
    // Lockout expired but failures not reset — treat as reset of window.
    state.lockedUntil = null
    state.windowStart = null
    state.failures = 0
  }

  // Start or advance the window.
  if (!state.windowStart) {
    state.windowStart = now.toISOString()
  } else {
    const windowStartMs = new Date(state.windowStart).getTime()
    if (nowMs - windowStartMs > windowMs) {
      state.windowStart = now.toISOString()
      state.failures = 0
    }
  }
  state.failures += 1

  if (state.failures >= threshold) {
    state.strikes += 1
    if (state.strikes >= maxStrikes) {
      state.wiped = true
      return { locked: true, wipe: true }
    }
    const unlockAt = new Date(nowMs + cooldownMs).toISOString()
    state.lockedUntil = unlockAt
    return { locked: true, unlockAt }
  }
  return { locked: false, remainingAttempts: threshold - state.failures }
}

/** Note a successful unlock. Resets window + failure count; `strikes` + `wiped` latch. */
export function recordSuccess(state: LockoutState): void {
  state.failures = 0
  state.windowStart = null
  state.lockedUntil = null
  // strikes + wiped deliberately persist — a successful unlock doesn't
  // erase the history that the keyring was under attack.
}

/** Check whether the keyring is currently locked without recording a failure. */
export function isLocked(state: LockoutState, now: Date = new Date()): boolean {
  if (state.wiped) return true
  if (!state.lockedUntil) return false
  return now.getTime() < new Date(state.lockedUntil).getTime()
}

// ─── #197 Duress passphrase (data destruct) ────────────────────────────

/**
 * Enroll a duress passphrase. Returns a `{ digest, salt }` pair to
 * persist alongside the keyring. On every unlock attempt the caller
 * runs `checkDuress(input, digest, salt)` BEFORE the normal PBKDF2
 * unlock — a match means the user entered the duress phrase, and the
 * caller should invoke the wipe handler.
 *
 * **Why hash-compare rather than wrap-attempt?** The duress passphrase
 * is intentionally a distinct secret from the real unlock passphrase —
 * wrapping a key against both would require storing a decoy DEK, which
 * defeats the "destroy on match" semantics. Hashing with a dedicated
 * salt lets us detect the duress passphrase without revealing anything
 * about the real one.
 */
export async function enrollDuress(passphrase: string): Promise<{ digest: string; salt: string }> {
  return hashWithFreshSalt(passphrase)
}

/** Returns true when `input` matches the enrolled duress passphrase. */
export async function checkDuress(input: string, digest: string, salt: string): Promise<boolean> {
  const computed = await hashWithSalt(input, salt)
  return constantTimeEqual(computed, digest)
}

// ─── #198 Duress passphrase (honeypot) ─────────────────────────────────

/**
 * Same enroll shape as `enrollDuress` — the caller keeps a separate
 * `{ digest, salt }` pair for the honeypot passphrase and routes
 * matches to a pre-seeded decoy vault instead of a wipe action.
 *
 * In practice a consumer configures either the destruct path OR the
 * honeypot path for a given keyring; shipping both primitives as a
 * single package keeps the security surface consistent and cuts
 * package proliferation.
 */
export const enrollHoneypot = enrollDuress
export const checkHoneypot = checkDuress

// ─── internals ─────────────────────────────────────────────────────────

async function hashWithFreshSalt(passphrase: string): Promise<{ digest: string; salt: string }> {
  const saltBytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const salt = toHex(saltBytes)
  const digest = await hashWithSalt(passphrase, salt)
  return { digest, salt }
}

async function hashWithSalt(passphrase: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder()
  const passBytes = enc.encode(passphrase)
  const saltBytes = fromHex(saltHex)
  // PBKDF2-SHA256 with 200k iterations — same ballpark as noy-db's 600k
  // for KEK derivation but this hash is just for passphrase comparison,
  // not key material. 200k keeps the UI snappy on low-end devices.
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    passBytes as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes as BufferSource, iterations: 200_000, hash: 'SHA-256' },
    keyMaterial,
    256,
  )
  return toHex(new Uint8Array(bits))
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

// The `LockoutPolicy` type alias kept for docstring cross-reference.
export type LockoutPolicy = LockoutConfig
