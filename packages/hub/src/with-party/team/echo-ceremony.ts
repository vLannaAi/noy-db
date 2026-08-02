/**
 * `beginEchoUnlock` — the interactive ceremony API (spec
 * docs/superpowers/specs/2026-08-02-echo-secret-design.md, #940, Task 6).
 *
 * Split out of `echo-secret.ts` (which owns only the block builders +
 * verifiers) because this module orchestrates BOTH `echo-secret.ts`
 * (`verifyPrompt`/`resolveEchoReveal`/`verifyTypedEcho`) AND `keyring.ts`
 * (`loadKeyring`) — and `keyring.ts` itself imports `buildEchoBlock` from
 * `echo-secret.ts`. Keeping the ceremony here instead of inside
 * `echo-secret.ts` yields a clean DAG (`echo-ceremony.ts` → {`echo-secret.ts`,
 * `keyring.ts`}; `keyring.ts` → `echo-secret.ts`) instead of a two-file
 * cycle, and restores `echo-secret.ts`'s documented charter (builders +
 * verifiers only).
 *
 * @module
 */

import type { KeyringFile, NoydbStore } from '../../kernel/types.js'
import type { DeviceSealProvider } from './device-seal.js'
import { WrongPromptError, WrongEchoError, ValidationError, NoAccessError } from '../../kernel/errors.js'
import { verifyPrompt, resolveEchoReveal, verifyTypedEcho } from './echo-secret.js'
import { loadKeyring, type UnlockedKeyring } from './keyring.js'

/** Options for {@link beginEchoUnlock}. */
export interface BeginEchoUnlockOptions {
  readonly userId: string
  readonly prompt: string
  readonly deviceSeal?: DeviceSealProvider
}

/**
 * A prompt-verified, in-progress echo unlock. Stateless w.r.t. attempts —
 * `complete()` may be called more than once (e.g. retry after a wrong key).
 */
export interface EchoCeremony {
  /** Echo to display for owner recognition; null ⇒ degraded: ask the owner to TYPE it. */
  readonly reveal: string | null
  readonly maskHint: string | undefined
  /** Complete the ceremony. `echo` is REQUIRED when `reveal` is null. */
  complete(input: { readonly echo?: string; readonly key: string }): Promise<UnlockedKeyring>
}

/**
 * Begin the interactive anti-phishing unlock ceremony (spec decision 4):
 * prompt → echo reveal → key. Fetches and parses the `_keyring/{userId}`
 * row (same store path as `loadKeyring`), verifies the prompt, and resolves
 * the echo for display (or degrades to the typed-echo path when the reveal
 * cannot be resolved — sealed reveal under a foreign device).
 *
 * @throws NoAccessError when no keyring exists for `userId` (mirrors
 * `loadKeyring`'s missing-row error).
 * @throws ValidationError when the keyring is not an echo keyring.
 * @throws WrongPromptError when the prompt fails its verifier.
 */
export async function beginEchoUnlock(
  store: NoydbStore,
  vault: string,
  opts: BeginEchoUnlockOptions,
): Promise<EchoCeremony> {
  const { userId, prompt, deviceSeal } = opts

  // Same store path + missing-row error as loadKeyring:230-233.
  const envelope = await store.get(vault, '_keyring', userId)
  if (!envelope) {
    throw new NoAccessError(`No keyring found for user "${userId}" in vault "${vault}"`)
  }
  const keyringFile = JSON.parse(envelope._data) as KeyringFile

  const block = keyringFile.echo
  if (block === undefined) {
    throw new ValidationError('not an echo keyring')
  }

  if (!(await verifyPrompt(block, prompt))) {
    throw new WrongPromptError()
  }

  const reveal = await resolveEchoReveal(block, prompt, deviceSeal)

  return {
    reveal,
    maskHint: block.mask_hint,
    async complete(input: { readonly echo?: string; readonly key: string }): Promise<UnlockedKeyring> {
      let echo: string
      if (reveal !== null) {
        // A supplied input.echo must agree with the revealed echo — defensive:
        // a player that collects a typed echo despite a reveal must not
        // silently unlock with a mismatched pair.
        if (input.echo !== undefined && input.echo !== reveal) {
          throw new WrongEchoError()
        }
        echo = reveal
      } else {
        if (input.echo === undefined) {
          throw new ValidationError('beginEchoUnlock: echo is required to complete a degraded (typed-echo) ceremony.')
        }
        if (!(await verifyTypedEcho(block, input.echo))) {
          throw new WrongEchoError()
        }
        echo = input.echo
      }
      return loadKeyring(store, vault, { userId, secret: { prompt, echo, key: input.key } })
    },
  }
}
