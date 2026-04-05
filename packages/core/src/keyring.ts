import type { NoydbAdapter, KeyringFile, Role, Permissions } from './types.js'
import { NOYDB_KEYRING_VERSION } from './types.js'
import {
  deriveKey,
  generateDEK,
  generateSalt,
  wrapKey,
  unwrapKey,
  bufferToBase64,
  base64ToBuffer,
} from './crypto.js'
import { NoAccessError } from './errors.js'

/** In-memory representation of an unlocked keyring. */
export interface UnlockedKeyring {
  readonly userId: string
  readonly displayName: string
  readonly role: Role
  readonly permissions: Permissions
  readonly deks: Map<string, CryptoKey>
  readonly kek: CryptoKey
  readonly salt: Uint8Array
}

/**
 * Load and unlock a user's keyring for a compartment.
 * Derives KEK from passphrase, then unwraps all DEKs.
 */
export async function loadKeyring(
  adapter: NoydbAdapter,
  compartment: string,
  userId: string,
  passphrase: string,
): Promise<UnlockedKeyring> {
  const envelope = await adapter.get(compartment, '_keyring', userId)

  if (!envelope) {
    throw new NoAccessError(`No keyring found for user "${userId}" in compartment "${compartment}"`)
  }

  const keyringFile: KeyringFile = JSON.parse(envelope._data) as KeyringFile
  const salt = base64ToBuffer(keyringFile.salt)
  const kek = await deriveKey(passphrase, salt)

  const deks = new Map<string, CryptoKey>()
  for (const [collName, wrappedDek] of Object.entries(keyringFile.deks)) {
    const dek = await unwrapKey(wrappedDek, kek)
    deks.set(collName, dek)
  }

  return {
    userId: keyringFile.user_id,
    displayName: keyringFile.display_name,
    role: keyringFile.role,
    permissions: keyringFile.permissions,
    deks,
    kek,
    salt,
  }
}

/**
 * Create the initial owner keyring for a new compartment.
 * Generates DEKs for any collections that will be created.
 */
export async function createOwnerKeyring(
  adapter: NoydbAdapter,
  compartment: string,
  userId: string,
  passphrase: string,
): Promise<UnlockedKeyring> {
  const salt = generateSalt()
  const kek = await deriveKey(passphrase, salt)

  const keyringFile: KeyringFile = {
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    user_id: userId,
    display_name: userId,
    role: 'owner',
    permissions: {},
    deks: {},
    salt: bufferToBase64(salt),
    created_at: new Date().toISOString(),
    granted_by: userId,
  }

  // Store keyring as a plain JSON string (not encrypted — only wrapped DEKs inside)
  const envelope = {
    _noydb: 1 as const,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(keyringFile),
  }

  await adapter.put(compartment, '_keyring', userId, envelope)

  return {
    userId,
    displayName: userId,
    role: 'owner',
    permissions: {},
    deks: new Map(),
    kek,
    salt,
  }
}

/**
 * Ensure a DEK exists for a collection in the keyring.
 * If the collection is new, generates a DEK and persists it.
 */
export async function ensureCollectionDEK(
  adapter: NoydbAdapter,
  compartment: string,
  keyring: UnlockedKeyring,
): Promise<(collectionName: string) => Promise<CryptoKey>> {
  return async (collectionName: string): Promise<CryptoKey> => {
    const existing = keyring.deks.get(collectionName)
    if (existing) return existing

    // Generate new DEK for this collection
    const dek = await generateDEK()
    keyring.deks.set(collectionName, dek)

    // Update the persisted keyring with the new wrapped DEK
    await persistKeyring(adapter, compartment, keyring)

    return dek
  }
}

/** Persist the current keyring state to the adapter. */
export async function persistKeyring(
  adapter: NoydbAdapter,
  compartment: string,
  keyring: UnlockedKeyring,
): Promise<void> {
  const wrappedDeks: Record<string, string> = {}
  for (const [collName, dek] of keyring.deks) {
    wrappedDeks[collName] = await wrapKey(dek, keyring.kek)
  }

  const keyringFile: KeyringFile = {
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    user_id: keyring.userId,
    display_name: keyring.displayName,
    role: keyring.role,
    permissions: keyring.permissions,
    deks: wrappedDeks,
    salt: bufferToBase64(keyring.salt),
    created_at: new Date().toISOString(),
    granted_by: keyring.userId,
  }

  const envelope = {
    _noydb: 1 as const,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(keyringFile),
  }

  await adapter.put(compartment, '_keyring', keyring.userId, envelope)
}

/** Check if a user has write permission for a collection. */
export function hasWritePermission(keyring: UnlockedKeyring, collectionName: string): boolean {
  if (keyring.role === 'owner' || keyring.role === 'admin') return true
  const perm = keyring.permissions[collectionName]
  return perm === 'rw'
}

/** Check if a user has any access to a collection. */
export function hasAccess(keyring: UnlockedKeyring, collectionName: string): boolean {
  if (keyring.role === 'owner' || keyring.role === 'admin' || keyring.role === 'viewer') return true
  return collectionName in keyring.permissions
}
