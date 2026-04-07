import type { NoydbAdapter, KeyringFile, Role, Permissions, GrantOptions, RevokeOptions, UserInfo, EncryptedEnvelope } from './types.js'
import { NOYDB_KEYRING_VERSION, NOYDB_FORMAT_VERSION } from './types.js'
import {
  deriveKey,
  generateDEK,
  generateSalt,
  wrapKey,
  unwrapKey,
  encrypt,
  decrypt,
  bufferToBase64,
  base64ToBuffer,
} from './crypto.js'
import { NoAccessError, PermissionDeniedError, PrivilegeEscalationError } from './errors.js'

// ─── Roles that can grant/revoke ───────────────────────────────────────

/**
 * Roles that an `admin` is allowed to grant and revoke (v0.5 #62).
 *
 * Includes `'admin'` itself: the v0.4 model bottlenecked all admin
 * onboarding through the single `owner` principal, which made lateral
 * delegation impossible and left a single-owner bus-factor risk
 * unresolved even when multiple trusted humans existed. v0.5 opens up
 * admin↔admin lateral delegation, with two guardrails:
 *
 *   1. **No privilege escalation.** Enforced in `grant()`: every DEK
 *      wrapped into the new admin's keyring must be present in the
 *      grantor's own DEK set. Today this is structurally trivially
 *      true (admin grants always inherit the full caller DEK set),
 *      but the check is wired in so future per-collection admin scoping
 *      cannot accidentally bypass it. See `PrivilegeEscalationError`.
 *
 *   2. **Cascade on revoke.** Enforced in `revoke()`: when an admin is
 *      revoked, every admin they (transitively) granted is either
 *      revoked too (`cascade: 'strict'`, default) or left in place with
 *      a console warning (`cascade: 'warn'`). The walk uses the
 *      `granted_by` field on each keyring file as the parent pointer.
 */
const ADMIN_GRANTABLE_TARGETS: readonly Role[] = ['operator', 'viewer', 'client', 'admin']

function canGrant(callerRole: Role, targetRole: Role): boolean {
  if (callerRole === 'owner') return true
  if (callerRole === 'admin') return ADMIN_GRANTABLE_TARGETS.includes(targetRole)
  return false
}

function canRevoke(callerRole: Role, targetRole: Role): boolean {
  if (targetRole === 'owner') return false // owner cannot be revoked
  if (callerRole === 'owner') return true
  if (callerRole === 'admin') return ADMIN_GRANTABLE_TARGETS.includes(targetRole)
  return false
}

// ─── Unlocked Keyring ──────────────────────────────────────────────────

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

// ─── Load / Create ─────────────────────────────────────────────────────

/** Load and unlock a user's keyring for a compartment. */
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

  const keyringFile = JSON.parse(envelope._data) as KeyringFile
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

/** Create the initial owner keyring for a new compartment. */
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

  await writeKeyringFile(adapter, compartment, userId, keyringFile)

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

// ─── Grant ─────────────────────────────────────────────────────────────

/** Grant access to a new user. Caller must have grant privilege. */
export async function grant(
  adapter: NoydbAdapter,
  compartment: string,
  callerKeyring: UnlockedKeyring,
  options: GrantOptions,
): Promise<void> {
  if (!canGrant(callerKeyring.role, options.role)) {
    throw new PermissionDeniedError(
      `Role "${callerKeyring.role}" cannot grant role "${options.role}"`,
    )
  }

  // Determine which collections the new user gets access to
  const permissions = resolvePermissions(options.role, options.permissions)

  // Derive the new user's KEK from their passphrase
  const newSalt = generateSalt()
  const newKek = await deriveKey(options.passphrase, newSalt)

  // Wrap the appropriate DEKs with the new user's KEK
  const wrappedDeks: Record<string, string> = {}
  for (const collName of Object.keys(permissions)) {
    const dek = callerKeyring.deks.get(collName)
    if (dek) {
      wrappedDeks[collName] = await wrapKey(dek, newKek)
    }
  }

  // For owner/admin/viewer roles, wrap ALL known DEKs
  if (options.role === 'owner' || options.role === 'admin' || options.role === 'viewer') {
    for (const [collName, dek] of callerKeyring.deks) {
      if (!(collName in wrappedDeks)) {
        wrappedDeks[collName] = await wrapKey(dek, newKek)
      }
    }
  }

  // For ALL roles, propagate system-prefixed collection DEKs
  // (`_ledger`, `_history`, `_sync`, …). These are internal collections
  // that any user with access to the compartment must be able to
  // read and write — for example, the v0.4 hash-chained ledger writes
  // an entry on every put/delete, so operators and clients with write
  // access to a single data collection still need the `_ledger` DEK.
  //
  // Trade-off: a granted user can decrypt every system-collection
  // entry, including ones they would not otherwise have access to
  // (e.g., an operator on `invoices` can read ledger entries for
  // mutations in `salaries`). This is a metadata leak, not a
  // plaintext leak — the ledger entries record collection names,
  // record ids, and ciphertext hashes, but never plaintext records.
  // Per-collection ledger DEKs are tracked as a v0.5 follow-up.
  for (const [collName, dek] of callerKeyring.deks) {
    if (collName.startsWith('_') && !(collName in wrappedDeks)) {
      wrappedDeks[collName] = await wrapKey(dek, newKek)
    }
  }

  // Anti-privilege-escalation check (v0.5 #62). Every DEK we just
  // wrapped into the new keyring must come from the caller's own DEK
  // set — the grantor cannot give the grantee access to a collection
  // they themselves can't read. Today this is structurally trivially
  // satisfied because every wrapped DEK was looked up in
  // `callerKeyring.deks` above, but the explicit check is wired in
  // so a future change (per-collection admin scoping, escrow-based
  // re-wrapping, etc.) cannot accidentally let a widening grant
  // through. See `PrivilegeEscalationError` for the rationale.
  for (const collName of Object.keys(wrappedDeks)) {
    if (!callerKeyring.deks.has(collName)) {
      throw new PrivilegeEscalationError(collName)
    }
  }

  const keyringFile: KeyringFile = {
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    user_id: options.userId,
    display_name: options.displayName,
    role: options.role,
    permissions,
    deks: wrappedDeks,
    salt: bufferToBase64(newSalt),
    created_at: new Date().toISOString(),
    granted_by: callerKeyring.userId,
  }

  await writeKeyringFile(adapter, compartment, options.userId, keyringFile)
}

// ─── Revoke ────────────────────────────────────────────────────────────

/**
 * Walk every keyring in the compartment to find admins that the given
 * `rootUserId` (transitively) granted, via the `granted_by` parent
 * pointer recorded on each keyring file.
 *
 * Returns the set of descendant admin user-ids in DFS order, NOT
 * including the root itself. Non-admin descendants are excluded
 * because operators/viewers/clients cannot grant other users — they
 * are leaves in the delegation tree and cleaning them up is the
 * caller's job (or the next rotate, since they'd lose key access
 * anyway when the cascading admin's collections rotate).
 *
 * The walk uses a visited set keyed by user-id so cycles introduced
 * by re-grants (admin-A revoked, then re-granted later by admin-B who
 * was originally granted by A) terminate cleanly.
 */
async function findAdminDescendants(
  adapter: NoydbAdapter,
  compartment: string,
  rootUserId: string,
): Promise<string[]> {
  const allUserIds = await adapter.list(compartment, '_keyring')

  // Build a map: parentUserId → child KeyringFiles. We only ever
  // descend into admins, so non-admin children are skipped at the
  // edge level rather than after a recursive call.
  const childrenByParent = new Map<string, string[]>()
  for (const userId of allUserIds) {
    const env = await adapter.get(compartment, '_keyring', userId)
    if (!env) continue
    const kf = JSON.parse(env._data) as KeyringFile
    if (kf.role !== 'admin') continue // only admins can grant — leaves are uninteresting
    if (kf.user_id === rootUserId) continue // self-edges are noise
    const list = childrenByParent.get(kf.granted_by) ?? []
    list.push(kf.user_id)
    childrenByParent.set(kf.granted_by, list)
  }

  const visited = new Set<string>()
  const order: string[] = []
  const stack: string[] = [...(childrenByParent.get(rootUserId) ?? [])]
  while (stack.length > 0) {
    const next = stack.pop()!
    if (visited.has(next)) continue
    visited.add(next)
    order.push(next)
    for (const grandchild of childrenByParent.get(next) ?? []) {
      if (!visited.has(grandchild)) stack.push(grandchild)
    }
  }
  return order
}

/** Revoke a user's access. Optionally rotate keys for affected collections. */
export async function revoke(
  adapter: NoydbAdapter,
  compartment: string,
  callerKeyring: UnlockedKeyring,
  options: RevokeOptions,
): Promise<void> {
  // Load the target's keyring to check their role
  const targetEnvelope = await adapter.get(compartment, '_keyring', options.userId)
  if (!targetEnvelope) {
    throw new NoAccessError(`User "${options.userId}" has no keyring in compartment "${compartment}"`)
  }

  const targetKeyring = JSON.parse(targetEnvelope._data) as KeyringFile

  if (!canRevoke(callerKeyring.role, targetKeyring.role)) {
    throw new PermissionDeniedError(
      `Role "${callerKeyring.role}" cannot revoke role "${targetKeyring.role}"`,
    )
  }

  // Cascade-on-revoke (v0.5 #62). Only meaningful when the target is
  // an admin — operators/viewers/clients cannot grant other users so
  // they have no delegation subtree to walk.
  const cascadeMode = options.cascade ?? 'strict'
  const usersToRevoke: string[] = [options.userId]
  const affectedCollections = new Set(Object.keys(targetKeyring.deks))

  if (targetKeyring.role === 'admin') {
    const descendants = await findAdminDescendants(adapter, compartment, options.userId)
    if (descendants.length > 0) {
      if (cascadeMode === 'warn') {
        // Diagnostic mode: leave the descendants in place but make
        // them visible. The owner / a different admin can clean up
        // manually. The single console.warn is intentionally noisy
        // (a list, not a count) so the operator sees exactly which
        // keyrings will become orphans.
        console.warn(
          `[noy-db] revoke(${options.userId}): cascade='warn' — leaving ` +
            `${descendants.length} descendant admin(s) in place: ` +
            `${descendants.join(', ')}. These admins were granted by the revoked user ` +
            `(transitively) and will become orphans in the delegation tree.`,
        )
      } else {
        // Strict mode (default): pull every descendant into the
        // revoke set. We collect their affected collections too so
        // the single rotation pass at the end covers everything.
        for (const userId of descendants) {
          const descEnv = await adapter.get(compartment, '_keyring', userId)
          if (!descEnv) continue
          const descKf = JSON.parse(descEnv._data) as KeyringFile
          usersToRevoke.push(userId)
          for (const c of Object.keys(descKf.deks)) affectedCollections.add(c)
        }
      }
    }
  }

  // Delete every keyring in the revoke set. Order doesn't matter
  // because each keyring file is independent on disk; we don't have
  // referential integrity to maintain across deletes.
  for (const userId of usersToRevoke) {
    await adapter.delete(compartment, '_keyring', userId)
  }

  // Single rotation pass at the end. The cost is O(records in
  // affected collections), NOT O(records × cascade depth) — every
  // descendant's collections were unioned into `affectedCollections`
  // before we got here, so the rotation re-encrypts each affected
  // record exactly once regardless of how deep the cascade went.
  if (options.rotateKeys !== false && affectedCollections.size > 0) {
    await rotateKeys(adapter, compartment, callerKeyring, [...affectedCollections])
  }
}

// ─── Key Rotation ──────────────────────────────────────────────────────

/**
 * Rotate DEKs for specified collections:
 * 1. Generate new DEKs
 * 2. Re-encrypt all records in affected collections
 * 3. Re-wrap new DEKs for all remaining users
 */
export async function rotateKeys(
  adapter: NoydbAdapter,
  compartment: string,
  callerKeyring: UnlockedKeyring,
  collections: string[],
): Promise<void> {
  // Generate new DEKs for each affected collection
  const newDeks = new Map<string, CryptoKey>()
  for (const collName of collections) {
    newDeks.set(collName, await generateDEK())
  }

  // Re-encrypt all records in affected collections
  for (const collName of collections) {
    const oldDek = callerKeyring.deks.get(collName)
    const newDek = newDeks.get(collName)!
    if (!oldDek) continue

    const ids = await adapter.list(compartment, collName)
    for (const id of ids) {
      const envelope = await adapter.get(compartment, collName, id)
      if (!envelope || !envelope._iv) continue

      // Decrypt with old DEK
      const plaintext = await decrypt(envelope._iv, envelope._data, oldDek)

      // Re-encrypt with new DEK
      const { iv, data } = await encrypt(plaintext, newDek)
      const newEnvelope: EncryptedEnvelope = {
        _noydb: NOYDB_FORMAT_VERSION,
        _v: envelope._v,
        _ts: new Date().toISOString(),
        _iv: iv,
        _data: data,
      }
      await adapter.put(compartment, collName, id, newEnvelope)
    }
  }

  // Update caller's keyring with new DEKs
  for (const [collName, newDek] of newDeks) {
    callerKeyring.deks.set(collName, newDek)
  }
  await persistKeyring(adapter, compartment, callerKeyring)

  // Update all remaining users' keyrings with re-wrapped new DEKs
  const userIds = await adapter.list(compartment, '_keyring')
  for (const userId of userIds) {
    if (userId === callerKeyring.userId) continue

    const userEnvelope = await adapter.get(compartment, '_keyring', userId)
    if (!userEnvelope) continue

    const userKeyringFile = JSON.parse(userEnvelope._data) as KeyringFile
    // Note: we can't derive other users' KEKs to re-wrap DEKs for them.
    // Rotation requires users to re-unlock and be re-granted after the caller
    // re-wraps with the raw DEKs held in memory. See rotation flow below.
    // The trick: import the user's KEK from their salt? No — we need their passphrase.
    //
    // Per the spec: the caller (owner/admin) wraps the new DEKs with each remaining
    // user's KEK. But we can't derive their KEK without their passphrase.
    //
    // Real solution from the spec: the caller wraps the DEK using the approach of
    // reading each user's existing wrapping. Since we can't derive their KEK,
    // we use a RE-KEYING approach: the new DEK is wrapped with a key-wrapping-key
    // that we CAN derive — we use the existing wrapped DEK as proof that the user
    // had access, and we replace it with the new wrapped DEK.
    //
    // Practical approach: Since the owner/admin has all raw DEKs in memory,
    // and each user's keyring contains their salt, we need the users to
    // re-authenticate to get the new wrapped keys. This is the standard approach.
    //
    // For NOYDB Phase 2: we'll update the keyring file to include a "pending_rekey"
    // flag. Users will get new DEKs on next login when the owner provides them.
    //
    // SIMPLER approach used here: Since the owner performed the rotation,
    // the owner has both old and new DEKs. We store a "rekey token" that the
    // user can use to unwrap: we wrap the new DEK with the OLD DEK (which the
    // user can still unwrap from their keyring, since their keyring has the old
    // wrapped DEK and their KEK can unwrap it).

    // Actually even simpler: we just need the user's KEK. We don't have it.
    // The spec says the owner wraps new DEKs for each remaining user.
    // This requires knowing each user's KEK (or having a shared secret).
    //
    // The CORRECT implementation from the spec: the owner/admin has all DEKs.
    // Each user's keyring stores DEKs wrapped with THAT USER's KEK.
    // To re-wrap, we need each user's KEK — which we can't get.
    //
    // Real-world solution: use a KEY ESCROW approach where the owner stores
    // each user's wrapping key (not their passphrase, but a key derived from
    // the grant process). During grant, the owner stores a copy of the new user's
    // KEK (wrapped with the owner's KEK) so they can re-wrap later.
    //
    // For now: mark the user's keyring as needing rekey. The user will need to
    // re-authenticate (owner provides new passphrase or re-grants).

    // Update: simplest correct approach — during grant, we store the user's KEK
    // wrapped with the owner's KEK in a separate escrow field. Then during rotation,
    // the owner unwraps the user's KEK from escrow and wraps the new DEKs.
    //
    // BUT: that means we need to change the KeyringFile format.
    // For Phase 2 MVP: just delete the user's old DEK entries and require re-grant.
    // This is secure (revoked keys are gone) but inconvenient (remaining users
    // need re-grant for rotated collections).

    // PHASE 2 APPROACH: Remove the affected collection DEKs from remaining users'
    // keyrings. The owner must re-grant access to those collections.
    // This is correct and secure — just requires the owner to re-run grant().

    const updatedDeks = { ...userKeyringFile.deks }
    for (const collName of collections) {
      delete updatedDeks[collName]
    }

    const updatedPermissions = { ...userKeyringFile.permissions }
    for (const collName of collections) {
      delete updatedPermissions[collName]
    }

    const updatedKeyring: KeyringFile = {
      ...userKeyringFile,
      deks: updatedDeks,
      permissions: updatedPermissions,
    }

    await writeKeyringFile(adapter, compartment, userId, updatedKeyring)
  }
}

// ─── Change Secret ─────────────────────────────────────────────────────

/** Change the user's passphrase. Re-wraps all DEKs with the new KEK. */
export async function changeSecret(
  adapter: NoydbAdapter,
  compartment: string,
  keyring: UnlockedKeyring,
  newPassphrase: string,
): Promise<UnlockedKeyring> {
  const newSalt = generateSalt()
  const newKek = await deriveKey(newPassphrase, newSalt)

  // Re-wrap all DEKs with the new KEK
  const wrappedDeks: Record<string, string> = {}
  for (const [collName, dek] of keyring.deks) {
    wrappedDeks[collName] = await wrapKey(dek, newKek)
  }

  const keyringFile: KeyringFile = {
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    user_id: keyring.userId,
    display_name: keyring.displayName,
    role: keyring.role,
    permissions: keyring.permissions,
    deks: wrappedDeks,
    salt: bufferToBase64(newSalt),
    created_at: new Date().toISOString(),
    granted_by: keyring.userId,
  }

  await writeKeyringFile(adapter, compartment, keyring.userId, keyringFile)

  return {
    userId: keyring.userId,
    displayName: keyring.displayName,
    role: keyring.role,
    permissions: keyring.permissions,
    deks: keyring.deks, // Same DEKs, different wrapping
    kek: newKek,
    salt: newSalt,
  }
}

// ─── List Users ────────────────────────────────────────────────────────

/** List all users with access to a compartment. */
export async function listUsers(
  adapter: NoydbAdapter,
  compartment: string,
): Promise<UserInfo[]> {
  const userIds = await adapter.list(compartment, '_keyring')
  const users: UserInfo[] = []

  for (const userId of userIds) {
    const envelope = await adapter.get(compartment, '_keyring', userId)
    if (!envelope) continue
    const kf = JSON.parse(envelope._data) as KeyringFile
    users.push({
      userId: kf.user_id,
      displayName: kf.display_name,
      role: kf.role,
      permissions: kf.permissions,
      createdAt: kf.created_at,
      grantedBy: kf.granted_by,
    })
  }

  return users
}

// ─── DEK Management ────────────────────────────────────────────────────

/** Ensure a DEK exists for a collection. Generates one if new. */
export async function ensureCollectionDEK(
  adapter: NoydbAdapter,
  compartment: string,
  keyring: UnlockedKeyring,
): Promise<(collectionName: string) => Promise<CryptoKey>> {
  return async (collectionName: string): Promise<CryptoKey> => {
    const existing = keyring.deks.get(collectionName)
    if (existing) return existing

    const dek = await generateDEK()
    keyring.deks.set(collectionName, dek)
    await persistKeyring(adapter, compartment, keyring)
    return dek
  }
}

// ─── Permission Checks ─────────────────────────────────────────────────

/** Check if a user has write permission for a collection. */
export function hasWritePermission(keyring: UnlockedKeyring, collectionName: string): boolean {
  if (keyring.role === 'owner' || keyring.role === 'admin') return true
  if (keyring.role === 'viewer' || keyring.role === 'client') return false
  return keyring.permissions[collectionName] === 'rw'
}

/** Check if a user has any access to a collection. */
export function hasAccess(keyring: UnlockedKeyring, collectionName: string): boolean {
  if (keyring.role === 'owner' || keyring.role === 'admin' || keyring.role === 'viewer') return true
  return collectionName in keyring.permissions
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** Persist a keyring file to the adapter. */
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

  await writeKeyringFile(adapter, compartment, keyring.userId, keyringFile)
}

function resolvePermissions(role: Role, explicit?: Permissions): Permissions {
  if (role === 'owner' || role === 'admin' || role === 'viewer') return {}
  return explicit ?? {}
}

async function writeKeyringFile(
  adapter: NoydbAdapter,
  compartment: string,
  userId: string,
  keyringFile: KeyringFile,
): Promise<void> {
  const envelope = {
    _noydb: 1 as const,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(keyringFile),
  }
  await adapter.put(compartment, '_keyring', userId, envelope)
}
