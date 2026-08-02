/**
 * Echo-block builders + verifiers (spec
 * docs/superpowers/specs/2026-08-02-echo-secret-design.md, #940).
 *
 * Builds and verifies the on-keyring {@link KeyringEchoBlock} declaration
 * for the 3-part echo ceremony (prompt → echo → key). This module owns:
 *
 *   - Minting the prompt/echo canary verifiers (the "canary trick": AES-KW
 *     wrap a constant 32-byte key under `deriveSecretKey(part, salt, …)`;
 *     verify = unwrap succeeds).
 *   - Building the reveal blob per the hybrid reveal policy (spec decision
 *     4): `portable` (AES-GCM under the prompt, own salt), `sealed`
 *     (opaque to hub, unsealed only by the enrolling device's
 *     {@link DeviceSealProvider}), or `none`.
 *   - Resolving the echo for display (`resolveEchoReveal`, `null` ⇒
 *     degraded typed-echo path) and verifying a typed echo
 *     (`verifyTypedEcho`) for that degraded path.
 *
 * Deriving the actual KEK from all three parts together is
 * `deriveEchoKey`/`encodeEchoParts` (`kernel/enclave/crypto.ts`) — a
 * separate concern from this module's per-part verifiers.
 *
 * @module
 */

import {
  deriveSecretKey,
  generateSalt,
  generateIV,
  wrapKey,
  bufferToBase64,
  base64ToBuffer,
  type EchoSecretParts,
} from '../../kernel/enclave/index.js'
import type { KeyringEchoBlock, KeyringFile, NoydbStore } from '../../kernel/types.js'
import type { DeviceSealProvider } from './device-seal.js'
import { WrongPromptError, WrongEchoError, ValidationError, NoAccessError } from '../../kernel/errors.js'
import { loadKeyring, type UnlockedKeyring } from './keyring.js'

/** Same iteration floor as the KEK (spec resolved question 1). */
export const ECHO_KDF_ITERATIONS = 600_000

const VERIFIER_PLAINTEXT = new Uint8Array(32).fill(0x5a)
const subtle = globalThis.crypto.subtle

async function getVerifierKey(): Promise<CryptoKey> {
  return subtle.importKey('raw', VERIFIER_PLAINTEXT as BufferSource, { name: 'AES-GCM' }, true, ['encrypt'])
}

async function mintVerifier(part: string, salt: Uint8Array): Promise<string> {
  const kek = await deriveSecretKey(part, salt, { iterations: ECHO_KDF_ITERATIONS, keyUsage: 'aes-kw' })
  return wrapKey(await getVerifierKey(), kek)
}

/**
 * `saltB64` and `verifier` are both decoded INSIDE the guarded region so a
 * tampered/corrupt base64 salt or verifier surfaces as `false`, not a raw
 * `DOMException` (InvalidCharacterError) escaping to the caller.
 */
async function checkVerifier(verifier: string, part: string, saltB64: string): Promise<boolean> {
  try {
    const kek = await deriveSecretKey(part, base64ToBuffer(saltB64), { iterations: ECHO_KDF_ITERATIONS, keyUsage: 'aes-kw' })
    await subtle.unwrapKey('raw', base64ToBuffer(verifier) as BufferSource, kek, 'AES-KW', { name: 'AES-GCM' }, false, ['encrypt'])
    return true
  } catch {
    return false
  }
}

export type EchoRevealChoice =
  | { readonly kind: 'portable' }
  | { readonly kind: 'sealed'; readonly deviceSeal: DeviceSealProvider }
  | { readonly kind: 'none' }

/** Build the on-keyring echo declaration for a fresh enrollment. */
export async function buildEchoBlock(
  parts: EchoSecretParts,
  reveal: EchoRevealChoice,
  maskHint?: string,
): Promise<KeyringEchoBlock> {
  const promptSalt = generateSalt()
  const echoSalt = generateSalt()
  let revealField: KeyringEchoBlock['reveal']
  if (reveal.kind === 'portable') {
    const blobSalt = generateSalt()
    const iv = generateIV()
    const gcmKey = await deriveSecretKey(parts.prompt, blobSalt, { iterations: ECHO_KDF_ITERATIONS, keyUsage: 'aes-gcm' })
    const ct = new Uint8Array(
      await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, gcmKey, new TextEncoder().encode(parts.echo)),
    )
    revealField = { kind: 'portable', blob: bufferToBase64(ct), iv: bufferToBase64(iv), salt: bufferToBase64(blobSalt) }
  } else if (reveal.kind === 'sealed') {
    const sealed = await reveal.deviceSeal.seal(new TextEncoder().encode(parts.echo))
    revealField = { kind: 'sealed', blob: bufferToBase64(sealed), provider_hint: reveal.deviceSeal.id }
  } else {
    revealField = { kind: 'none' }
  }
  return {
    v: 1,
    prompt_salt: bufferToBase64(promptSalt),
    prompt_verifier: await mintVerifier(parts.prompt, promptSalt),
    echo_salt: bufferToBase64(echoSalt),
    echo_verifier: await mintVerifier(parts.echo, echoSalt),
    reveal: revealField,
    ...(maskHint !== undefined ? { mask_hint: maskHint } : {}),
  }
}

export async function verifyPrompt(block: KeyringEchoBlock, prompt: string): Promise<boolean> {
  return checkVerifier(block.prompt_verifier, prompt, block.prompt_salt)
}

/**
 * Resolve the echo for display. `null` ⇒ degraded path: the player
 * must ask the owner to TYPE the echo (verify via {@link verifyTypedEcho}).
 * Callers MUST verify the prompt first — this assumes it.
 *
 * @throws WrongPromptError when the prompt cannot open the portable reveal
 * (callers should verifyPrompt first for a boolean check).
 */
export async function resolveEchoReveal(
  block: KeyringEchoBlock,
  prompt: string,
  deviceSeal?: DeviceSealProvider,
): Promise<string | null> {
  if (block.reveal.kind === 'portable') {
    try {
      const gcmKey = await deriveSecretKey(prompt, base64ToBuffer(block.reveal.salt), {
        iterations: ECHO_KDF_ITERATIONS,
        keyUsage: 'aes-gcm',
      })
      const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBuffer(block.reveal.iv) as BufferSource },
        gcmKey,
        base64ToBuffer(block.reveal.blob) as BufferSource,
      )
      return new TextDecoder().decode(plain)
    } catch {
      // Wrong prompt (or corrupt salt/iv/blob) — a wrong prompt must NOT
      // silently degrade to the typed-echo path, that would weaken mutual
      // auth. Surface a typed error instead of the raw DOMException.
      throw new WrongPromptError()
    }
  }
  if (block.reveal.kind === 'sealed' && deviceSeal !== undefined) {
    if (deviceSeal.id !== block.reveal.provider_hint) {
      // Legitimate foreign-device-with-its-own-provider case (spec's
      // degradation matrix) — degrade to the typed-echo path rather than
      // attempting (and failing) an unseal under the wrong provider.
      return null
    }
    // Same provider id: a thrown error here is a genuine tamper/wrong-device
    // anomaly and must surface, not be silently masked.
    const plain = await deviceSeal.unseal(base64ToBuffer(block.reveal.blob))
    return new TextDecoder().decode(plain)
  }
  return null
}

export async function verifyTypedEcho(block: KeyringEchoBlock, echo: string): Promise<boolean> {
  return checkVerifier(block.echo_verifier, echo, block.echo_salt)
}

// ─── Interactive ceremony API (Task 6) ──────────────────────────────

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
