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
import type { KeyringEchoBlock } from '../../kernel/types.js'
import type { DeviceSealProvider } from './device-seal.js'

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

async function checkVerifier(verifier: string, part: string, salt: Uint8Array): Promise<boolean> {
  const kek = await deriveSecretKey(part, salt, { iterations: ECHO_KDF_ITERATIONS, keyUsage: 'aes-kw' })
  try {
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
  return checkVerifier(block.prompt_verifier, prompt, base64ToBuffer(block.prompt_salt))
}

/**
 * Resolve the echo for display. `null` ⇒ degraded path: the player
 * must ask the owner to TYPE the echo (verify via {@link verifyTypedEcho}).
 * Callers MUST verify the prompt first — this assumes it.
 */
export async function resolveEchoReveal(
  block: KeyringEchoBlock,
  prompt: string,
  deviceSeal?: DeviceSealProvider,
): Promise<string | null> {
  if (block.reveal.kind === 'portable') {
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
  }
  if (block.reveal.kind === 'sealed' && deviceSeal !== undefined) {
    const plain = await deviceSeal.unseal(base64ToBuffer(block.reveal.blob))
    return new TextDecoder().decode(plain)
  }
  return null
}

export async function verifyTypedEcho(block: KeyringEchoBlock, echo: string): Promise<boolean> {
  return checkVerifier(block.echo_verifier, echo, base64ToBuffer(block.echo_salt))
}
