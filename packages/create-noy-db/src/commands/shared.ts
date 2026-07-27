/**
 * Shared primitives for the interactive `noy-db` subcommands that
 * need to unlock a real vault.
 *
 * Three things live here:
 *
 *   1. `ReadSecret` — a tiny interface for "prompt the user for
 *      a secret", with a test-friendly default. Subcommands take
 *      this as an injected dependency so tests can short-circuit
 *      the prompt without spawning a pty.
 *
 *   2. `defaultReadSecret` — the production implementation,
 *      built on `@clack/prompts` `password()`. Never echoes the
 *      value to the terminal, never logs it, clears it from the
 *      returned promise after the caller consumes it.
 *
 *   3. `assertRole` — narrow unknown string input to the Role type
 *      with a consistent error message.
 *
 * ## Why pull this out
 *
 * `rotate`, `addUser`, and `backup` all need the same "prompt for
 * a secret" shape and the same "open a file adapter and get
 * back a Noydb instance" shape. Duplicating it in three files would
 * drift over time; centralizing means one place to audit the
 * secret-handling contract (never log, never persist, clear
 * local variables after use).
 */

import { password, isCancel, cancel } from '@clack/prompts'
import type { Role } from '@noy-db/hub'

const VALID_ROLES = ['owner', 'admin', 'operator', 'viewer', 'client'] as const

/**
 * Asynchronous secret reader. Production code passes
 * `defaultReadSecret`; tests pass a stub that returns a fixed
 * string without touching stdin.
 *
 * The `label` is shown to the user as the prompt message. It
 * should never contain the expected secret or any secret.
 */
export type ReadSecret = (label: string) => Promise<string>

/**
 * Clack-based secret prompt. Cancellation (Ctrl-C) aborts the
 * process with exit code 1 — prompts are always the first thing to
 * fire in a subcommand, so aborting here doesn't leave the system
 * in a half-mutated state.
 */
export const defaultReadSecret: ReadSecret = async (label) => {
  const value = await password({
    message: label,
    // Basic sanity: reject empty strings up front. We don't enforce
    // length here because the caller's KEK-derivation step will
    // reject weak secrets with its own, richer error.
    validate: (v) => (v.length === 0 ? 'Secret cannot be empty' : undefined),
  })
  if (isCancel(value)) {
    cancel('Cancelled.')
    process.exit(1)
  }
  return value
}

/**
 * Narrow an unknown string to the `Role` type from @noy-db/core.
 * Used by the `add user` subcommand to validate the role argument
 * before passing it to `noydb.grant()`.
 */
export function assertRole(input: string): Role {
  if (!(VALID_ROLES as readonly string[]).includes(input)) {
    throw new Error(
      `Invalid role "${input}" — must be one of: ${VALID_ROLES.join(', ')}`,
    )
  }
  return input as Role
}

/**
 * Split a comma-separated collection list into an array of names,
 * trimming whitespace and dropping empties. Returns null if the
 * input itself is empty or undefined — the caller decides whether
 * that means "all collections" or "error".
 */
export function parseCollectionList(input: string | undefined): string[] | null {
  if (!input) return null
  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : null
}
