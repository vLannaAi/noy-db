import { bufferToBase64, base64ToBuffer } from './crypto.js'
import { ValidationError } from './errors.js'

/**
 * WebAuthn biometric enrollment and unlock.
 *
 * Enrollment: User enters passphrase → derive KEK → create WebAuthn credential
 *   → wrap KEK with credential-derived key → store { credentialId, wrappedKek }
 *
 * Unlock: Retrieve { credentialId, wrappedKek } → WebAuthn assertion
 *   → unwrap KEK → proceed as passphrase auth
 *
 * This module requires a browser environment with WebAuthn support.
 */

export interface BiometricCredential {
  credentialId: string
  wrappedKek: string
  salt: string
}

/** Check if WebAuthn is available in the current environment. */
export function isBiometricAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials !== 'undefined'
  )
}

/**
 * Enroll a biometric credential for the current user.
 * Must be called after passphrase authentication (KEK is in memory).
 *
 * @param userId - User identifier for WebAuthn
 * @param kek - The KEK derived from the user's passphrase (in memory)
 * @returns BiometricCredential to persist in browser storage
 */
export async function enrollBiometric(
  userId: string,
  kek: CryptoKey,
): Promise<BiometricCredential> {
  if (!isBiometricAvailable()) {
    throw new ValidationError('WebAuthn is not available in this environment')
  }

  // Create a WebAuthn credential
  const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const userIdBytes = new TextEncoder().encode(userId)

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'NOYDB' },
      user: {
        id: userIdBytes,
        name: userId,
        displayName: userId,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },  // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60_000,
    },
  }) as PublicKeyCredential | null

  if (!credential) {
    throw new ValidationError('Biometric enrollment was cancelled')
  }

  // Export KEK and wrap it with a key derived from the credential
  const rawKek = await globalThis.crypto.subtle.exportKey('raw', kek)
  const wrappingKey = await deriveWrappingKey(credential.rawId)
  const iv = new Uint8Array(12) as unknown as ArrayBuffer
  const wrappedKek = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    rawKek,
  )

  return {
    credentialId: bufferToBase64(credential.rawId),
    wrappedKek: bufferToBase64(wrappedKek),
    salt: bufferToBase64(globalThis.crypto.getRandomValues(new Uint8Array(32))),
  }
}

/**
 * Unlock using a previously enrolled biometric credential.
 *
 * @param storedCredential - The stored BiometricCredential from enrollment
 * @returns The unwrapped KEK as a CryptoKey
 */
export async function unlockBiometric(
  storedCredential: BiometricCredential,
): Promise<CryptoKey> {
  if (!isBiometricAvailable()) {
    throw new ValidationError('WebAuthn is not available in this environment')
  }

  const credentialId = base64ToBuffer(storedCredential.credentialId)

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{
        type: 'public-key',
        id: credentialId as BufferSource,
      }],
      userVerification: 'required',
      timeout: 60_000,
    },
  }) as PublicKeyCredential | null

  if (!assertion) {
    throw new ValidationError('Biometric authentication was cancelled')
  }

  // Unwrap KEK using credential-derived key
  const wrappingKey = await deriveWrappingKey(assertion.rawId)
  const unlockIv = new Uint8Array(12) as unknown as ArrayBuffer
  const rawKek = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unlockIv },
    wrappingKey,
    base64ToBuffer(storedCredential.wrappedKek) as BufferSource,
  )

  return globalThis.crypto.subtle.importKey(
    'raw',
    rawKek,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

/** Remove biometric enrollment from browser storage. */
export function removeBiometric(storage: Storage, userId: string): void {
  storage.removeItem(`noydb:biometric:${userId}`)
}

/** Save biometric credential to browser storage. */
export function saveBiometric(storage: Storage, userId: string, credential: BiometricCredential): void {
  storage.setItem(`noydb:biometric:${userId}`, JSON.stringify(credential))
}

/** Load biometric credential from browser storage. */
export function loadBiometric(storage: Storage, userId: string): BiometricCredential | null {
  const data = storage.getItem(`noydb:biometric:${userId}`)
  return data ? JSON.parse(data) as BiometricCredential : null
}

// ─── Internal ──────────────────────────────────────────────────────────

async function deriveWrappingKey(rawId: ArrayBuffer): Promise<CryptoKey> {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    rawId,
    'HKDF',
    false,
    ['deriveKey'],
  )

  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('noydb-biometric-wrapping'),
      info: new TextEncoder().encode('kek-wrap'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}
