/**
 * Dev-mode persistent unlock — v0.7 #119
 *
 * Solves the developer inner-loop friction: hot-reload destroys the session
 * (page navigation semantics), forcing a passphrase re-entry every refresh.
 *
 * This module provides an opt-in, deliberately-named escape hatch that lets
 * developers store the keyring payload in sessionStorage or localStorage so
 * the compartment auto-unlocks on every page load — without a passphrase,
 * without a biometric prompt, without any OIDC flow.
 *
 * ⚠️ WARNING — this is a loaded footgun ⚠️
 * ─────────────────────────────────────────
 * The keyring payload stored by this module contains the DEKs. Whoever has
 * access to sessionStorage/localStorage has access to the DEKs. On a shared
 * development machine, a compromised browser extension, or a mis-configured
 * origin, this is a complete key exposure.
 *
 * This module is ONLY safe for local development. It must NEVER be active
 * in production builds.
 *
 * Guardrails (all enforced by the module, not by the caller)
 * ──────────────────────────────────────────────────────────
 * 1. **Production guard:** `enableDevUnlock()` throws immediately if
 *    `process.env.NODE_ENV === 'production'` or if `import.meta.env?.PROD === true`
 *    (Vite convention). Also throws if the hostname is NOT localhost or 127.0.0.1.
 *
 * 2. **Explicit acknowledgement string:** the caller must pass
 *    `acknowledge: 'I-UNDERSTAND-THIS-DISABLES-UNLOCK-SECURITY'` or the call
 *    throws. This string appears in every grep for `devUnlock` in the codebase,
 *    making it impossible to enable this feature accidentally.
 *
 * 3. **Scope is compartment + userId:** the storage key includes both the
 *    compartment name and the userId, so dev-unlock for compartment-A does
 *    NOT auto-unlock compartment-B.
 *
 * 4. **Storage scope:** default is `sessionStorage` (cleared on tab close).
 *    `localStorage` is opt-in and requires an additional
 *    `persistAcrossTabs: true` flag in the options.
 *
 * 5. **Clear method:** `clearDevUnlock()` removes the stored payload. Wire
 *    this to a dev toolbar button or `Ctrl+Shift+L` so clearing is one action.
 *
 * 6. **Console banner:** on first enable, a highly visible console warning
 *    fires. Cannot be suppressed.
 *
 * Usage
 * ─────
 * ```ts
 * // In your dev entry point only (guarded by import.meta.env.DEV):
 * if (import.meta.env.DEV) {
 *   const { enableDevUnlock, loadDevUnlock } = await import('@noy-db/core')
 *   enableDevUnlock('my-compartment', 'alice', keyring, {
 *     acknowledge: 'I-UNDERSTAND-THIS-DISABLES-UNLOCK-SECURITY',
 *   })
 * }
 *
 * // On page load:
 * if (import.meta.env.DEV) {
 *   const keyring = await loadDevUnlock('my-compartment', 'alice')
 *   if (keyring) {
 *     // Skip unlock prompt, use keyring directly
 *   }
 * }
 * ```
 */

import { bufferToBase64, base64ToBuffer } from './crypto.js'
import { ValidationError } from './errors.js'
import type { UnlockedKeyring } from './keyring.js'
import type { Role } from './types.js'

// The exact acknowledgement string callers must pass
const REQUIRED_ACKNOWLEDGE = 'I-UNDERSTAND-THIS-DISABLES-UNLOCK-SECURITY'

const STORAGE_PREFIX = 'noydb:dev-unlock:'

// ─── Options ──────────────────────────────────────────────────────────

export interface DevUnlockOptions {
  /**
   * Required: the exact string 'I-UNDERSTAND-THIS-DISABLES-UNLOCK-SECURITY'.
   * Any other value causes `enableDevUnlock()` to throw.
   */
  acknowledge: string
  /**
   * If `true`, stores in localStorage (persists across tabs and browser restarts).
   * If `false` (default), stores in sessionStorage (cleared on tab close).
   */
  persistAcrossTabs?: boolean
}

// ─── Production guard ─────────────────────────────────────────────────

function assertDevEnvironment(): void {
  // Node.js: check NODE_ENV
  if (
    typeof process !== 'undefined' &&
    process.env.NODE_ENV === 'production'
  ) {
    throw new ValidationError(
      'devUnlock is not available in production builds. ' +
      'process.env.NODE_ENV is "production".',
    )
  }

  // Vite / build tool convention
  if (
    typeof globalThis !== 'undefined' &&
    (globalThis as Record<string, unknown>).__vite_is_production__ === true
  ) {
    throw new ValidationError('devUnlock is not available in production builds.')
  }

  // Browser: only allow on localhost
  if (
    typeof window !== 'undefined' &&
    typeof window.location !== 'undefined'
  ) {
    const host = window.location.hostname
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && !host.endsWith('.local')) {
      throw new ValidationError(
        `devUnlock is only available on localhost. Current hostname: "${host}". ` +
        'Set NODE_ENV=development and run on localhost to use dev unlock.',
      )
    }
  }
}

// ─── Storage key ──────────────────────────────────────────────────────

function storageKey(compartment: string, userId: string): string {
  return `${STORAGE_PREFIX}${compartment}:${userId}`
}

function resolveStorage(persistAcrossTabs?: boolean): Storage {
  if (typeof window === 'undefined') {
    throw new ValidationError('devUnlock requires a browser environment (window.sessionStorage / window.localStorage).')
  }
  return persistAcrossTabs ? window.localStorage : window.sessionStorage
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Serialize and store a keyring to browser storage for dev-mode auto-unlock.
 *
 * Throws immediately if:
 *   - The acknowledge string is wrong.
 *   - Running in a production environment (NODE_ENV=production).
 *   - Running on a non-localhost hostname.
 *
 * Emits a highly visible console warning that cannot be suppressed.
 *
 * @param compartment - The compartment name.
 * @param userId - The user ID.
 * @param keyring - The unlocked keyring to persist.
 * @param options - Options including the required acknowledge string.
 */
export async function enableDevUnlock(
  compartment: string,
  userId: string,
  keyring: UnlockedKeyring,
  options: DevUnlockOptions,
): Promise<void> {
  if (options.acknowledge !== REQUIRED_ACKNOWLEDGE) {
    throw new ValidationError(
      `devUnlock requires acknowledge: '${REQUIRED_ACKNOWLEDGE}'. ` +
      `Got: '${options.acknowledge}'. This is intentional — the full string must appear in your source.`,
    )
  }

  assertDevEnvironment()

  const storage = resolveStorage(options.persistAcrossTabs)

  const dekMap: Record<string, string> = {}
  for (const [collName, dek] of keyring.deks) {
    const raw = await globalThis.crypto.subtle.exportKey('raw', dek)
    dekMap[collName] = bufferToBase64(raw)
  }

  const payload = JSON.stringify({
    _noydb_dev_unlock: 1,
    userId: keyring.userId,
    displayName: keyring.displayName,
    role: keyring.role,
    permissions: keyring.permissions,
    deks: dekMap,
    salt: bufferToBase64(keyring.salt),
  })

  storage.setItem(storageKey(compartment, userId), payload)

  // Visible, unsuppressable warning
  console.warn(
    '%c⚠️ NOYDB DEV UNLOCK ACTIVE ⚠️',
    'color: red; font-size: 16px; font-weight: bold',
    `\n\nCompartment "${compartment}" user "${userId}" is stored in ` +
    `${options.persistAcrossTabs ? 'localStorage' : 'sessionStorage'} in PLAINTEXT DEKs.\n` +
    'This is ONLY safe for local development. Never use in production.\n' +
    'Call clearDevUnlock() to remove.',
  )
}

/**
 * Load a dev-mode keyring from browser storage.
 *
 * Returns `null` if no dev-unlock state is stored for this compartment + user,
 * or if the stored payload is malformed.
 *
 * Does NOT perform the production environment check — it's safe to CALL
 * `loadDevUnlock` in production (it will simply return `null` because no
 * dev-unlock state was ever written). The guard only fires on `enableDevUnlock`.
 *
 * @param compartment - The compartment name.
 * @param userId - The user ID.
 * @param options - Optional storage override.
 */
export async function loadDevUnlock(
  compartment: string,
  userId: string,
  options: { persistAcrossTabs?: boolean } = {},
): Promise<UnlockedKeyring | null> {
  if (typeof window === 'undefined') return null

  const storage = resolveStorage(options.persistAcrossTabs)
  const raw = storage.getItem(storageKey(compartment, userId))
  if (!raw) return null

  let parsed: {
    _noydb_dev_unlock?: number
    userId: string
    displayName: string
    role: Role
    permissions: Record<string, 'rw' | 'ro'>
    deks: Record<string, string>
    salt: string
  }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (parsed._noydb_dev_unlock !== 1) return null

  const deks = new Map<string, CryptoKey>()
  for (const [collName, rawBase64] of Object.entries(parsed.deks)) {
    const dek = await globalThis.crypto.subtle.importKey(
      'raw',
      base64ToBuffer(rawBase64),
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    deks.set(collName, dek)
  }

  return {
    userId: parsed.userId,
    displayName: parsed.displayName,
    role: parsed.role,
    permissions: parsed.permissions,
    deks,
    kek: null as unknown as CryptoKey,
    salt: base64ToBuffer(parsed.salt),
  }
}

/**
 * Remove dev-unlock state from browser storage.
 *
 * Safe to call in production (no-op if no dev state exists).
 */
export function clearDevUnlock(
  compartment: string,
  userId: string,
  options: { persistAcrossTabs?: boolean } = {},
): void {
  if (typeof window === 'undefined') return
  const storage = resolveStorage(options.persistAcrossTabs)
  storage.removeItem(storageKey(compartment, userId))
}

/**
 * Check if dev-unlock state exists for this compartment + user.
 *
 * Safe to call in production (returns false if nothing is stored).
 */
export function isDevUnlockActive(
  compartment: string,
  userId: string,
  options: { persistAcrossTabs?: boolean } = {},
): boolean {
  if (typeof window === 'undefined') return false
  const storage = resolveStorage(options.persistAcrossTabs)
  return storage.getItem(storageKey(compartment, userId)) !== null
}
