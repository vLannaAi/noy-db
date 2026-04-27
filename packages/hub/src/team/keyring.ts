import type { NoydbStore, KeyringFile, Role, Permissions, GrantOptions, RevokeOptions, UserInfo, EncryptedEnvelope, ExportCapability, ExportFormat } from '../types.js'
import { NOYDB_KEYRING_VERSION, NOYDB_FORMAT_VERSION } from '../types.js'
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
} from '../crypto.js'
import { NoAccessError, PermissionDeniedError, PrivilegeEscalationError } from '../errors.js'

// ─── Roles that can grant/revoke ───────────────────────────────────────

/**
 * Roles that an `admin` is allowed to grant and revoke.
 *
 * Includes `'admin'` itself: the model bottlenecked all admin
 * onboarding through the single `owner` principal, which made lateral
 * delegation impossible and left a single-owner bus-factor risk
 * unresolved even when multiple trusted humans existed. opens up
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
  /**
   * `@noy-db/as-*` export capability (RFC #249). Absent when the
   * keyring was written before this RFC landed — role-based defaults
   * apply via `hasExportCapability`.
   */
  readonly exportCapability?: ExportCapability
}

// ─── Load / Create ─────────────────────────────────────────────────────

/** Load and unlock a user's keyring for a vault. */
export async function loadKeyring(
  adapter: NoydbStore,
  vault: string,
  userId: string,
  passphrase: string,
): Promise<UnlockedKeyring> {
  const envelope = await adapter.get(vault, '_keyring', userId)

  if (!envelope) {
    throw new NoAccessError(`No keyring found for user "${userId}" in vault "${vault}"`)
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
    ...(keyringFile.export_capability !== undefined && { exportCapability: keyringFile.export_capability }),
  }
}

/** Create the initial owner keyring for a new vault. */
export async function createOwnerKeyring(
  adapter: NoydbStore,
  vault: string,
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

  await writeKeyringFile(adapter, vault, userId, keyringFile)

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
  adapter: NoydbStore,
  vault: string,
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
  // that any user with access to the vault must be able to
  // read and write — for example, the hash-chained ledger writes
  // an entry on every put/delete, so operators and clients with write
  // access to a single data collection still need the `_ledger` DEK.
  //
  // Trade-off: a granted user can decrypt every system-collection
  // entry, including ones they would not otherwise have access to
  // (e.g., an operator on `invoices` can read ledger entries for
  // mutations in `salaries`). This is a metadata leak, not a
  // plaintext leak — the ledger entries record collection names,
  // record ids, and ciphertext hashes, but never plaintext records.
  // Per-collection ledger DEKs are tracked as a follow-up.
  for (const [collName, dek] of callerKeyring.deks) {
    if (collName.startsWith('_') && !(collName in wrappedDeks)) {
      wrappedDeks[collName] = await wrapKey(dek, newKek)
    }
  }

  // Anti-privilege-escalation check. Every DEK we just
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
    ...(options.exportCapability !== undefined && { export_capability: options.exportCapability }),
  }

  await writeKeyringFile(adapter, vault, options.userId, keyringFile)
}

// ─── Revoke ────────────────────────────────────────────────────────────

/**
 * Walk every keyring in the vault to find admins that the given
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
  adapter: NoydbStore,
  vault: string,
  rootUserId: string,
): Promise<string[]> {
  const allUserIds = await adapter.list(vault, '_keyring')

  // Build a map: parentUserId → child KeyringFiles. We only ever
  // descend into admins, so non-admin children are skipped at the
  // edge level rather than after a recursive call.
  const childrenByParent = new Map<string, string[]>()
  for (const userId of allUserIds) {
    const env = await adapter.get(vault, '_keyring', userId)
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
  adapter: NoydbStore,
  vault: string,
  callerKeyring: UnlockedKeyring,
  options: RevokeOptions,
): Promise<void> {
  // Load the target's keyring to check their role
  const targetEnvelope = await adapter.get(vault, '_keyring', options.userId)
  if (!targetEnvelope) {
    throw new NoAccessError(`User "${options.userId}" has no keyring in vault "${vault}"`)
  }

  const targetKeyring = JSON.parse(targetEnvelope._data) as KeyringFile

  if (!canRevoke(callerKeyring.role, targetKeyring.role)) {
    throw new PermissionDeniedError(
      `Role "${callerKeyring.role}" cannot revoke role "${targetKeyring.role}"`,
    )
  }

  // Cascade-on-revoke. Only meaningful when the target is
  // an admin — operators/viewers/clients cannot grant other users so
  // they have no delegation subtree to walk.
  const cascadeMode = options.cascade ?? 'strict'
  const usersToRevoke: string[] = [options.userId]
  const affectedCollections = new Set(Object.keys(targetKeyring.deks))

  if (targetKeyring.role === 'admin') {
    const descendants = await findAdminDescendants(adapter, vault, options.userId)
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
          const descEnv = await adapter.get(vault, '_keyring', userId)
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
    await adapter.delete(vault, '_keyring', userId)
  }

  // Single rotation pass at the end. The cost is O(records in
  // affected collections), NOT O(records × cascade depth) — every
  // descendant's collections were unioned into `affectedCollections`
  // before we got here, so the rotation re-encrypts each affected
  // record exactly once regardless of how deep the cascade went.
  if (options.rotateKeys !== false && affectedCollections.size > 0) {
    await rotateKeys(adapter, vault, callerKeyring, [...affectedCollections])
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
  adapter: NoydbStore,
  vault: string,
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

    const ids = await adapter.list(vault, collName)
    for (const id of ids) {
      const envelope = await adapter.get(vault, collName, id)
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
      await adapter.put(vault, collName, id, newEnvelope)
    }
  }

  // Update caller's keyring with new DEKs
  for (const [collName, newDek] of newDeks) {
    callerKeyring.deks.set(collName, newDek)
  }
  await persistKeyring(adapter, vault, callerKeyring)

  // Update all remaining users' keyrings with re-wrapped new DEKs
  const userIds = await adapter.list(vault, '_keyring')
  for (const userId of userIds) {
    if (userId === callerKeyring.userId) continue

    const userEnvelope = await adapter.get(vault, '_keyring', userId)
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

    await writeKeyringFile(adapter, vault, userId, updatedKeyring)
  }
}

// ─── Change Secret ─────────────────────────────────────────────────────

/** Change the user's passphrase. Re-wraps all DEKs with the new KEK. */
export async function changeSecret(
  adapter: NoydbStore,
  vault: string,
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

  await writeKeyringFile(adapter, vault, keyring.userId, keyringFile)

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

// ─── Bundle recipients (#301) ──────────────────────────────────────────

/**
 * Recipient slot in a re-keyed `.noydb` bundle. Each slot becomes its
 * own keyring file inside the bundle, sealed with its own passphrase.
 * Same role/permission semantics as `db.grant()` but no adapter side
 * effect — the slot only exists inside the bundle bytes.
 *
 * @public
 */
export interface BundleRecipient {
  /** User id stamped onto the keyring file in the bundle. */
  readonly id: string
  /** Optional display name. Defaults to `id`. */
  readonly displayName?: string
  /** Passphrase the recipient will type to unlock. */
  readonly passphrase: string
  /** Role on the destination vault. Defaults to `'viewer'`. */
  readonly role?: Role
  /**
   * Per-collection permissions. When omitted, role defaults apply.
   * Restricting permissions here ALSO restricts which DEKs are wrapped
   * into the slot — a slot with `{ invoices: 'ro' }` cannot decrypt
   * other collections even though their ciphertext sits in the bundle.
   */
  readonly permissions?: Permissions
  /**
   * Optional `as-*` export grants on the destination vault.
   * Mirrors the `exportCapability` field on a live keyring.
   */
  readonly exportCapability?: ExportCapability
}

/**
 * Build a `KeyringFile` for one bundle recipient, given the source
 * vault's unwrapped DEKs. Mirrors `grant()` minus the adapter write —
 * the produced file is meant to be embedded in the bundle's
 * `keyrings` map, never persisted to the source vault.
 *
 * Privilege-escalation check still runs: every DEK wrapped into the
 * recipient's keyring must come from the source's own DEK set.
 *
 * @internal
 */
export async function buildRecipientKeyringFile(
  callerKeyring: UnlockedKeyring,
  recipient: BundleRecipient,
): Promise<KeyringFile> {
  const role: Role = recipient.role ?? 'viewer'
  const permissions = resolvePermissions(role, recipient.permissions)

  const newSalt = generateSalt()
  const newKek = await deriveKey(recipient.passphrase, newSalt)

  const wrappedDeks: Record<string, string> = {}

  // Collections the recipient was explicitly granted permission to.
  for (const collName of Object.keys(permissions)) {
    const dek = callerKeyring.deks.get(collName)
    if (dek) {
      wrappedDeks[collName] = await wrapKey(dek, newKek)
    }
  }

  // owner / admin / viewer: wrap every known DEK (matches grant).
  if (role === 'owner' || role === 'admin' || role === 'viewer') {
    for (const [collName, dek] of callerKeyring.deks) {
      if (!(collName in wrappedDeks)) {
        wrappedDeks[collName] = await wrapKey(dek, newKek)
      }
    }
  }

  // Always propagate system-prefixed collection DEKs (`_ledger`, etc.) —
  // the recipient needs them to verify the bundle on import.
  for (const [collName, dek] of callerKeyring.deks) {
    if (collName.startsWith('_') && !(collName in wrappedDeks)) {
      wrappedDeks[collName] = await wrapKey(dek, newKek)
    }
  }

  // Anti-privilege-escalation: every wrapped DEK must come from the
  // caller's own DEK set. Belt-and-braces with the lookups above.
  for (const collName of Object.keys(wrappedDeks)) {
    if (!callerKeyring.deks.has(collName)) {
      throw new PrivilegeEscalationError(collName)
    }
  }

  return {
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    user_id: recipient.id,
    display_name: recipient.displayName ?? recipient.id,
    role,
    permissions,
    deks: wrappedDeks,
    salt: bufferToBase64(newSalt),
    created_at: new Date().toISOString(),
    granted_by: callerKeyring.userId,
    ...(recipient.exportCapability !== undefined
      ? { export_capability: recipient.exportCapability }
      : {}),
  }
}

// ─── List Users ────────────────────────────────────────────────────────

/** List all users with access to a vault. */
export async function listUsers(
  adapter: NoydbStore,
  vault: string,
): Promise<UserInfo[]> {
  const userIds = await adapter.list(vault, '_keyring')
  const users: UserInfo[] = []

  for (const userId of userIds) {
    const envelope = await adapter.get(vault, '_keyring', userId)
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
  adapter: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
): Promise<(collectionName: string) => Promise<CryptoKey>> {
  // Dedupe concurrent first-time DEK creates per collection. Without
  // this, two concurrent `getDEK('foo')` calls both pass the `existing`
  // check (the Map is empty), both generate fresh DEKs, and the second
  // `set` overwrites the first — making any envelope encrypted with
  // the discarded DEK fail to decrypt later (TamperedError on read).
  // Pre-existing race exposed by the multi-writer ledger work in #296.
  const inFlight = new Map<string, Promise<CryptoKey>>()
  return async (collectionName: string): Promise<CryptoKey> => {
    const existing = keyring.deks.get(collectionName)
    if (existing) return existing
    const pending = inFlight.get(collectionName)
    if (pending) return pending

    const promise = (async () => {
      const dek = await generateDEK()
      keyring.deks.set(collectionName, dek)
      await persistKeyring(adapter, vault, keyring)
      return dek
    })()
    inFlight.set(collectionName, promise)
    try {
      return await promise
    } finally {
      inFlight.delete(collectionName)
    }
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
  adapter: NoydbStore,
  vault: string,
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
    ...(keyring.exportCapability !== undefined && { export_capability: keyring.exportCapability }),
  }

  await writeKeyringFile(adapter, vault, keyring.userId, keyringFile)
}

// ─── Export capability (RFC #249) ──────────────────────────────────────

/**
 * Role-based default policy for the encrypted-bundle capability.
 *
 * Applied when `keyring.exportCapability` is absent or
 * `exportCapability.bundle` is undefined:
 *
 * - `owner` / `admin` → `true` (happy-path backup without friction)
 * - `operator` / `viewer` / `client` → `false` (explicit grant required)
 *
 * Rationale: a bundle is inert without the KEK, so an owner backing up
 * their own vault doesn't need friction; a non-admin role producing a
 * bundle for an external party does, because the bundle outlives
 * keyring revocation.
 */
function defaultBundleCapability(role: Role): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * Check whether a keyring is authorised for a given `@noy-db/as-*`
 * export tier (RFC #249).
 *
 * - `tier: 'plaintext'` — returns true iff `exportCapability.plaintext`
 *   contains the requested `format` or the `'*'` wildcard. Default for
 *   every role is empty — no grant, no plaintext export.
 * - `tier: 'bundle'` — returns `exportCapability.bundle` if present, or
 *   the role-based default otherwise (owner/admin → true, else false).
 *
 * `@noy-db/as-*` packages MUST call this before invoking the underlying
 * export primitive. Rogue forks that skip the check are caught by code
 * review — the single-entry-point contract is a convention, not a
 * runtime invariant. Vault-level gated wrappers
 * (`vault.exportRecords` / `exportBlobs` / `writeBundle`) will land in a
 * follow-up PR to enforce at the primitive level.
 */
export function hasExportCapability(
  keyring: UnlockedKeyring,
  tier: 'plaintext',
  format: ExportFormat,
): boolean
export function hasExportCapability(
  keyring: UnlockedKeyring,
  tier: 'bundle',
): boolean
export function hasExportCapability(
  keyring: UnlockedKeyring,
  tier: 'plaintext' | 'bundle',
  format?: ExportFormat,
): boolean {
  const cap = keyring.exportCapability
  if (tier === 'plaintext') {
    const allowed = cap?.plaintext ?? []
    return allowed.includes('*') || (format !== undefined && allowed.includes(format))
  }
  // tier === 'bundle'
  return cap?.bundle ?? defaultBundleCapability(keyring.role)
}

/**
 * Same-shape inspector for an `ExportCapability` value that isn't yet
 * attached to a keyring (e.g. for previewing a grant before applying).
 * Role must be supplied separately so bundle defaults can be computed.
 */
export function evaluateExportCapability(
  capability: ExportCapability | undefined,
  role: Role,
  tier: 'plaintext',
  format: ExportFormat,
): boolean
export function evaluateExportCapability(
  capability: ExportCapability | undefined,
  role: Role,
  tier: 'bundle',
): boolean
export function evaluateExportCapability(
  capability: ExportCapability | undefined,
  role: Role,
  tier: 'plaintext' | 'bundle',
  format?: ExportFormat,
): boolean {
  if (tier === 'plaintext') {
    const allowed = capability?.plaintext ?? []
    return allowed.includes('*') || (format !== undefined && allowed.includes(format))
  }
  return capability?.bundle ?? defaultBundleCapability(role)
}

function resolvePermissions(role: Role, explicit?: Permissions): Permissions {
  if (role === 'owner' || role === 'admin' || role === 'viewer') return {}
  return explicit ?? {}
}

async function writeKeyringFile(
  adapter: NoydbStore,
  vault: string,
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
  await adapter.put(vault, '_keyring', userId, envelope)
}
