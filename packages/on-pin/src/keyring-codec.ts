/**
 * Shared keyring (de)serialization plumbing for this package's two
 * session-resume modes — PIN quick-lock (`index.ts`) and device-trust
 * (`device-trust.ts`).
 *
 * Both modes cache the SAME payload: the unlocked session's identity
 * fields + raw DEK bytes, JSON-serialized, then AES-GCM-encrypted under
 * a mode-specific wrapping key (PIN-derived vs. device-bound). Neither
 * ever carries the KEK — a resumed keyring always has `kek: null`.
 *
 * @internal
 * @module
 */

import type { Role, Permissions, UnlockedKeyring } from '@noy-db/hub'

interface SerializedKeyring {
  userId: string
  displayName: string
  role: Role
  permissions: Permissions
  salt: string
  deks: Record<string, string>
}

/**
 * Serialize an unlocked keyring (identity fields + raw DEK bytes) to
 * UTF-8 JSON bytes. Requires every DEK to be extractable
 * (`crypto.subtle.exportKey('raw', dek)` — the hub mints DEKs this way).
 */
export async function serializeKeyring(k: UnlockedKeyring): Promise<Uint8Array> {
  const deks: Record<string, string> = {}
  for (const [collection, key] of k.deks) {
    const raw = await crypto.subtle.exportKey('raw', key)
    deks[collection] = bytesToBase64(new Uint8Array(raw))
  }
  const json: SerializedKeyring = {
    userId: k.userId,
    displayName: k.displayName,
    role: k.role,
    permissions: k.permissions,
    salt: bytesToBase64(k.salt),
    deks,
  }
  return new TextEncoder().encode(JSON.stringify(json))
}

/**
 * Reverse of {@link serializeKeyring}. Re-imports each DEK as a
 * functional AES-GCM key. The returned keyring has `kek: null` —
 * session-resume never reconstructs the KEK (by design).
 */
export async function deserializeKeyring(bytes: Uint8Array): Promise<UnlockedKeyring> {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SerializedKeyring
  const deks = new Map<string, CryptoKey>()
  for (const [coll, b64] of Object.entries(parsed.deks)) {
    const raw = base64ToBytes(b64)
    const key = await crypto.subtle.importKey(
      'raw',
      raw as BufferSource,
      { name: 'AES-GCM' },
      true,
      ['encrypt', 'decrypt'],
    )
    deks.set(coll, key)
  }
  return {
    userId: parsed.userId,
    displayName: parsed.displayName,
    role: parsed.role,
    permissions: parsed.permissions,
    salt: base64ToBytes(parsed.salt),
    deks,
    // KEK is deliberately null — session-resume returns a keyring that
    // can read/write but cannot open additional vaults or rotate keys.
    kek: null,
    authenticators: [],
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
