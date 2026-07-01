import type { NoydbStore, KeyringFile, KeyringAuthenticator, Role, Permissions, GrantOptions, RevokeOptions, UpdateUserOptions, UserInfo, EncryptedEnvelope, ExportCapability, ExportFormat, ImportCapability, VaultPolicyOnDisk } from '../../kernel/types.js'
import { NOYDB_KEYRING_VERSION, NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
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
} from '../../kernel/enclave/crypto.js'
import { NoAccessError, PermissionDeniedError, PrivilegeEscalationError, KeyringExpiredError, KeyringCorruptError, InvalidKeyError, ValidationError, DirectoryDisabledError } from '../../kernel/errors.js'
import { readDirectoryConfig } from '../directory/storage.js'
import { readUserVisibility, deleteUserVisibility } from '../directory/visibility.js'
import { assertStrongPassphrase, type PassphrasePolicy } from '../../validation.js'
import {
  saveUserEnvelope,
  loadUserEnvelope as loadUserEnvelopeFn,
  deleteUserEnvelope,
  USER_ENVELOPE_COLLECTION,
  type UserEnvelope as UserEnvelopeReader,
} from '../../meta/user-envelope/index.js'

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
// FR-6: 'custodian' is deliberately ABSENT here. An admin must not be able
// to mint (or revoke) a custodian — only the (sealed Deed) owner can, because
// the custodian is the de-facto operational authority and granting one is an
// ownership-level act. `canGrant(admin, 'custodian')` therefore returns false.
const ADMIN_GRANTABLE_TARGETS: readonly Role[] = ['operator', 'viewer', 'client', 'admin']

function canGrant(callerRole: Role, targetRole: Role): boolean {
  if (callerRole === 'owner') return true
  // FR-6: a custodian can never grant — it holds the DEKs to OPERATE the
  // vault but no authority to widen the principal set. Explicit + fail-safe
  // (it would also fall through to `return false`, but spell it out).
  if (callerRole === 'custodian') return false
  if (callerRole === 'admin') return ADMIN_GRANTABLE_TARGETS.includes(targetRole)
  return false
}

function canRevoke(callerRole: Role, targetRole: Role): boolean {
  if (targetRole === 'owner') return false // owner cannot be revoked
  if (callerRole === 'owner') return true
  // FR-6: a custodian can never revoke — same non-owning rationale as canGrant.
  if (callerRole === 'custodian') return false
  if (callerRole === 'admin') return ADMIN_GRANTABLE_TARGETS.includes(targetRole)
  return false
}

/**
 * Whether `callerRole` can mutate a keyring whose role is (or becomes)
 * `targetRole`. Used by `updateKeyringIdentity`.
 *
 * Mirrors `canGrant`'s hierarchy: admins manage admin/operator/viewer/
 * client laterally; admins cannot create or destroy `owner`-shaped
 * keyrings. Owner can do anything.
 *
 * Both the OLD role and the NEW role must satisfy this check —
 * otherwise admin could elevate themselves (`admin → owner`) or demote
 * an owner (`owner → admin`) under cover of "update."
 */
function canUpdateRole(callerRole: Role, targetRole: Role): boolean {
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
  /**
   * The KEK, when this keyring was unlocked via tier 1 (passphrase) or
   * a wrap-KEK tier-2 method (WebAuthn / OIDC). `null` when the
   * keyring was opened via:
   *
   *   - Unencrypted mode (no KEK exists)
   *   - Tier-3 PIN quick-resume (`@noy-db/on-pin`)
   *   - Wrap-DEKs tier-2 unlock (`@noy-db/on-password`'s
   *     `verifyPasswordSlot`)
   *   - Session-state restore (`session/session.ts`)
   *   - Dev-unlock fixture (`session/dev-unlock.ts`)
   *
   * Consumers performing tier-1 operations that need the KEK
   * (DEK rewrap, keyring persist, delegation issue/unwrap) must
   * null-check and throw a clear error if absent — re-authenticate
   * at tier 1 first to recover the KEK.
   *
   * Tightened from `CryptoKey` to `CryptoKey | null`; the runtime
   * contract has always allowed null, the type now matches reality.
   */
  readonly kek: CryptoKey | null
  readonly salt: Uint8Array
  /**
   * Debug-plaintext layout flag. Set only on the plaintext keyring created
   * in `encrypt: false` + `debugPlaintext: true` mode — it lives here
   * because its lifecycle is identical to the plaintext keyring's (no
   * encrypted vault ever has it, so this never widens the encrypted surface).
   * When true, user-collection records are written with their fields inlined
   * beside the envelope metadata (`_debug: 1`) so native store tooling can
   * read them without unwrapping `_data`.
   */
  readonly debugPlaintext?: boolean
  /**
   * `@noy-db/as-*` export capability. Absent when the
   * keyring was written before this RFC landed — role-based defaults
   * apply via `hasExportCapability`.
   */
  readonly exportCapability?: ExportCapability
  /**
   * `@noy-db/as-*` import capability. Absent when the
   * keyring was written before the import-capability extension
   * landed — default-closed semantics
   * apply via `hasImportCapability` (no plaintext format granted, no
   * bundle import granted, regardless of role).
   */
  readonly importCapability?: ImportCapability
  /**
   * Tier-2 authenticator slots — readonly snapshot loaded from the
   * keyring file. Mutations go through `enrollAuthenticator` /
   * `removeAuthenticator`, which write back via
   * `persistKeyring`. Always defined; loads with an empty array for
   * keyrings written before the multi-slot extension landed.
   */
  readonly authenticators: readonly KeyringAuthenticator[]
  /**
   * Reserved per-keyring policy override (forward-compat for Option C
   * — see {@link VaultPolicyOnDisk}). v1.0 round-trips this field but
   * never enforces it; the gate engine uses `_meta/policy` only.
   */
  readonly policy?: VaultPolicyOnDisk
}

// ─── Passphrase canary ─────────────────────────────────────────────────
//
// The canary is a fixed 256-bit AES-GCM key (32 zero bytes), wrapped
// under the keyring's KEK with AES-KW. Because AES-KW is deterministic
// (RFC 3394 fixed IV), wrapping the same constant under the same KEK
// always yields the same ciphertext — so every write site can mint
// fresh on each persist without round-tripping a `canary` field
// through UnlockedKeyring.
//
// On load, the canary unwraps cleanly iff the KEK is correct AND the
// canary bytes on disk are intact. Combined with each-DEK try/catch,
// this distinguishes wrong-passphrase (canary fails AND every DEK fails)
// from corruption (canary succeeds OR at least one DEK succeeds) —
// closing the all-DEKs-corrupt and single-DEK ambiguities that the
// pre-canary heuristic left open.

const CANARY_PLAINTEXT_BYTES = new Uint8Array(32)
let canaryKeyPromise: Promise<CryptoKey> | null = null

function getCanaryKey(): Promise<CryptoKey> {
  if (canaryKeyPromise === null) {
    canaryKeyPromise = globalThis.crypto.subtle.importKey(
      'raw',
      CANARY_PLAINTEXT_BYTES as BufferSource,
      { name: 'AES-GCM', length: 256 },
      true, // extractable so AES-KW can wrap it
      ['encrypt', 'decrypt'],
    )
  }
  return canaryKeyPromise
}

/** Mint a fresh wrapped-canary string. Deterministic for a given KEK. */
export async function mintKeyringCanary(kek: CryptoKey): Promise<string> {
  const canaryKey = await getCanaryKey()
  return wrapKey(canaryKey, kek)
}

/** Try to unwrap the canary. Returns true iff KEK + canary bytes are intact. */
async function verifyKeyringCanary(wrappedCanary: string, kek: CryptoKey): Promise<boolean> {
  try {
    await unwrapKey(wrappedCanary, kek)
    return true
  } catch {
    return false
  }
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

  //  — refuse to unwrap an expired slot. Check happens before any
  // KEK derivation so an expired slot doesn't leak timing on the
  // passphrase. Comparison uses Date.parse → ms-since-epoch; an
  // unparseable expires_at is treated as "no expiry" so a malformed
  // value can't silently lock users out (it'll surface in tests).
  if (keyringFile.expires_at !== undefined) {
    const cutoff = Date.parse(keyringFile.expires_at)
    if (Number.isFinite(cutoff) && Date.now() >= cutoff) {
      throw new KeyringExpiredError({ userId: keyringFile.user_id, expiresAt: keyringFile.expires_at })
    }
  }

  const salt = base64ToBuffer(keyringFile.salt)
  const kek = await deriveKey(passphrase, salt)

  // Verify the canary first when present. A canary success proves the
  // KEK is correct independent of any DEK byte — so subsequent DEK
  // unwrap failures are unambiguously corruption, not wrong-pass. A
  // canary failure with at least one DEK success indicates the KEK
  // is correct but the canary itself is corrupt.
  // `null` sentinel = legacy keyring without canary; falls back to the
  // multi-DEK heuristic.
  const canaryOk: boolean | null = keyringFile.canary !== undefined
    ? await verifyKeyringCanary(keyringFile.canary, kek)
    : null

  // Unwrap each DEK independently — collect successes and failures.
  const deks = new Map<string, CryptoKey>()
  const failedCollections: string[] = []
  let firstUnwrapError: unknown = null
  for (const [collName, wrappedDek] of Object.entries(keyringFile.deks)) {
    try {
      const dek = await unwrapKey(wrappedDek, kek)
      deks.set(collName, dek)
    } catch (err) {
      failedCollections.push(collName)
      if (firstUnwrapError === null) firstUnwrapError = err
    }
  }

  if (canaryOk === true) {
    // KEK proven correct by the canary. Any DEK failure is corruption.
    if (failedCollections.length > 0) {
      throw new KeyringCorruptError({ failedCollections, intactCount: deks.size })
    }
  } else if (canaryOk === false) {
    // Canary failed. If any DEK unwrapped, KEK is correct → canary bytes
    // are corrupted (rare; reported under the '_canary' sentinel).
    if (deks.size > 0) {
      throw new KeyringCorruptError({
        failedCollections: [...failedCollections, '_canary'],
        intactCount: deks.size,
      })
    }
    // Canary failed AND no DEK unwrapped — wrong KEK (or whole-file
    // corruption). Surface the original InvalidKeyError so
    // onInvalidKey: 'reset' can fire its documented recovery path.
    throw firstUnwrapError instanceof Error ? firstUnwrapError : new InvalidKeyError()
  } else {
    // Legacy keyring (no canary). Fall back to the multi-DEK heuristic.
    if (failedCollections.length > 0) {
      if (deks.size > 0) {
        throw new KeyringCorruptError({ failedCollections, intactCount: deks.size })
      }
      throw firstUnwrapError instanceof Error ? firstUnwrapError : new InvalidKeyError()
    }
  }

  return {
    userId: keyringFile.user_id,
    displayName: keyringFile.display_name,
    role: keyringFile.role,
    permissions: keyringFile.permissions,
    deks,
    kek,
    salt,
    authenticators: keyringFile.authenticators ?? [],
    ...(keyringFile.export_capability !== undefined && { exportCapability: keyringFile.export_capability }),
    ...(keyringFile.import_capability !== undefined && { importCapability: keyringFile.import_capability }),
    ...(keyringFile.policy !== undefined && { policy: keyringFile.policy }),
  }
}

/**
 * Open-policy pre-gate (#313): decide create-vs-fail-closed **before** any
 * vault write. `openVault` must not self-provision an owner keyring into a
 * vault held by other principals; create-on-open is allowed only for a
 * genuinely-new vault (no `_keyring/*` at all). Capability-free — one
 * `store.list`. Returns when the open may proceed (the caller is a member, or
 * the vault is genuinely-new and `create` is allowed, in which case the caller
 * falls through to the normal `createOwnerKeyring` path); throws `NoAccessError`
 * otherwise. Placed before managed-passphrase secret resolution (which persists
 * on first open), so a fail-closed open writes nothing.
 */
export async function assertKeyringOpenAllowed(
  store: NoydbStore,
  vault: string,
  userId: string,
  create: boolean,
): Promise<void> {
  const keyringUsers = await store.list(vault, '_keyring')
  if (keyringUsers.includes(userId)) return // caller is a member → load existing
  if (!create) {
    throw new NoAccessError(`Vault "${vault}" not opened: create disabled and no keyring for "${userId}".`)
  }
  if (keyringUsers.length > 0) {
    throw new NoAccessError(
      `No keyring for user "${userId}" in vault "${vault}" (held by other principals) — refusing to self-provision.`,
    )
  }
  // empty → genuinely-new vault → caller proceeds to the create path
}

/**
 * Create the initial owner keyring for a new vault.
 *
 * Pass `{ validate: true }` (or a `PassphrasePolicy`) to gate creation
 * on the phrase-format strength rules — `Noydb` threads this from
 * `NoydbOptions.validatePassphrase`. Direct callers (CLI, scripts,
 * test fixtures) opt in explicitly.
 */
export async function createOwnerKeyring(
  adapter: NoydbStore,
  vault: string,
  userId: string,
  passphrase: string,
  passphraseOpts?: PassphrasePolicy & { validate?: boolean; allowWeakPassphrase?: boolean },
): Promise<UnlockedKeyring> {
  if (passphraseOpts?.validate && !passphraseOpts.allowWeakPassphrase) {
    assertStrongPassphrase(passphrase, passphraseOpts)
  }
  const salt = generateSalt()
  const kek = await deriveKey(passphrase, salt)

  // Eager-provision the _users DEK at owner creation. This guarantees
  // every subsequent grant inherits it via the existing
  // collName.startsWith('_') propagation in grant() — so multi-principal
  // user-envelope reads (alice reading bob's profile) work for new
  // vaults without any per-keyring DEK rotation. Pre-existing vaults
  // get the DEK lazily on first vault.user.* access (which only
  // materializes a single-principal DEK that won't propagate
  // retroactively — that's the documented "lazy creation for
  // pre-existing keyrings" rollout note in the spec).
  const userEnvelopeDek = await generateDEK()
  const wrappedUserEnvelopeDek = await wrapKey(userEnvelopeDek, kek)
  const canary = await mintKeyringCanary(kek)

  const keyringFile: KeyringFile = {
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    user_id: userId,
    display_name: userId,
    role: 'owner',
    permissions: {},
    deks: { [USER_ENVELOPE_COLLECTION]: wrappedUserEnvelopeDek },
    salt: bufferToBase64(salt),
    created_at: new Date().toISOString(),
    granted_by: userId,
    canary,
  }

  await writeKeyringFile(adapter, vault, userId, keyringFile)

  return {
    userId,
    displayName: userId,
    role: 'owner',
    permissions: {},
    deks: new Map([[USER_ENVELOPE_COLLECTION, userEnvelopeDek]]),
    kek,
    salt,
    authenticators: [],
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
  if (!callerKeyring.kek) {
    throw new ValidationError(
      'grant: caller keyring has no KEK — tier-2 wrap-DEKs and tier-3 PIN-resume ' +
        'sessions cannot grant access to other users. Re-authenticate at tier 1 ' +
        '(passphrase) before granting.',
    )
  }

  if (!canGrant(callerKeyring.role, options.role)) {
    throw new PermissionDeniedError(
      `Role "${callerKeyring.role}" cannot grant role "${options.role}"`,
    )
  }

  // Optional strength validation — opt-in via grant({ validatePassphrase: true })
  // or via the calling Noydb's NoydbOptions.validatePassphrase flag.
  // The override `allowWeakPassphrase: true` skips even when validate is on.
  if (
    (options as { validatePassphrase?: boolean }).validatePassphrase &&
    !options.allowWeakPassphrase
  ) {
    assertStrongPassphrase(options.passphrase)
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

  // For owner/admin/custodian/viewer roles, wrap ALL known DEKs.
  // FR-6: a custodian operates EVERY collection, so — like admin — it must
  // receive every collection DEK on grant. Without this branch a custodian
  // could neither read nor write and the role would be inert.
  if (
    options.role === 'owner' ||
    options.role === 'admin' ||
    options.role === 'custodian' ||
    options.role === 'viewer'
  ) {
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

  const canary = await mintKeyringCanary(newKek)
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
    canary,
    ...(options.exportCapability !== undefined && { export_capability: options.exportCapability }),
    ...(options.importCapability !== undefined && { import_capability: options.importCapability }),
  }

  await writeKeyringFile(adapter, vault, options.userId, keyringFile)

  // User envelope bootstrap. Seeded with `options.initialProfile` if
  // provided, otherwise an empty `{}`. Encrypted with the caller's
  // _users DEK — which is the same DEK that was wrapped into the new
  // keyring's `wrappedDeks[USER_ENVELOPE_COLLECTION]` above (system-
  // collection propagation), so the new user can decrypt it on first
  // open. Skipped silently if the caller has no _users DEK (pre-feature
  // vault upgrade path — documented "lazy creation for pre-existing
  // keyrings" in the spec).
  const userEnvelopeDek = callerKeyring.deks.get(USER_ENVELOPE_COLLECTION)
  if (userEnvelopeDek) {
    const initialPayload = options.initialProfile ?? {}
    await saveUserEnvelope(
      adapter,
      vault,
      options.userId,
      initialPayload,
      userEnvelopeDek,
    )
  }
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
    // Only admins can grant, so only admins have a delegation subtree to
    // cascade. FR-6: a custodian is intentionally EXCLUDED here — it cannot
    // grant (canGrant(custodian,*) === false), so it is never a cascade root
    // and never a descendant edge. Treating it as an admin-descendant would
    // wrongly sweep it into an admin's revoke cascade.
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
    // Cascade-delete the principal's user envelope. Idempotent — no
    // error when the envelope was never written (e.g. the user was
    // granted but never authenticated to write their own profile).
    await deleteUserEnvelope(adapter, vault, userId)
    // Also drop the visibility sidecar at `_meta/visibility/<userId>`.
    // If the same `userId` is re-granted later (rare for humans,
    // possible for service accounts and test fixtures), the new
    // principal must start with a fresh visibility state instead of
    // silently inheriting the revoked user's `hidden` flag.
    await deleteUserVisibility(adapter, vault, userId)
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

// ─── Update User ───────────────────────────────────────────────────────

/**
 * Mutate `role`, `displayName`, and/or `permissions` on an existing
 * keyring. Pure plaintext-header rewrite — no DEK rewrap, no KEK
 * required, no authenticator slots touched. Tier-2 enrollments and
 * recovery codes survive the operation.
 *
 * Role-elevation guard: BOTH the old role AND the new role must
 * satisfy `canUpdateRole(callerRole, _)`. This blocks the two
 * privilege-escalation shapes:
 *   - admin elevates someone (or themselves) to owner
 *   - admin demotes an owner to a role they then control
 *
 * Owner is always allowed. Admin manages admin / operator / viewer /
 * client laterally.
 *
 * Identity preserved: same userId, same DEK wrappings. Last-write-wins
 * through the standard keyring put (same concurrency story as `grant`
 * and `revoke`).
 *
 * @throws `NoAccessError` when no keyring exists for the target.
 * @throws `PermissionDeniedError` when the role hierarchy rejects.
 * @throws `ValidationError` when the diff is empty (nothing to update).
 *
 */
export async function updateKeyringIdentity(
  adapter: NoydbStore,
  vault: string,
  callerKeyring: UnlockedKeyring,
  options: UpdateUserOptions,
): Promise<void> {
  if (
    options.role === undefined &&
    options.displayName === undefined &&
    options.permissions === undefined
  ) {
    throw new ValidationError(
      `updateUser: at least one of role / displayName / permissions must be provided ` +
        `(userId: "${options.userId}").`,
    )
  }

  const env = await adapter.get(vault, '_keyring', options.userId)
  if (!env) {
    throw new NoAccessError(
      `updateUser: user "${options.userId}" has no keyring in vault "${vault}".`,
    )
  }
  const target = JSON.parse(env._data) as KeyringFile

  // Role-elevation guard. The OLD role must be one this caller is
  // allowed to manage, AND the NEW role (if changing) must be too.
  // Two-sided check: blocks admin→owner promotion (new side) and
  // demoting an owner (old side).
  if (!canUpdateRole(callerKeyring.role, target.role)) {
    throw new PermissionDeniedError(
      `Role "${callerKeyring.role}" cannot update a keyring with role "${target.role}"`,
    )
  }
  if (
    options.role !== undefined &&
    options.role !== target.role &&
    !canUpdateRole(callerKeyring.role, options.role)
  ) {
    throw new PermissionDeniedError(
      `Role "${callerKeyring.role}" cannot promote target to role "${options.role}"`,
    )
  }

  const next: KeyringFile = {
    ...target,
    ...(options.role !== undefined && { role: options.role }),
    ...(options.displayName !== undefined && {
      // null clears the field (stored as ""); a string sets it.
      display_name: options.displayName ?? '',
    }),
    ...(options.permissions !== undefined && { permissions: options.permissions }),
  }

  await writeKeyringFile(adapter, vault, options.userId, next)
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
  // FR-6: re-keying is an owner-only meta-capability. A custodian operates the
  // vault fully but must NOT rotate — rotation would let it mint fresh DEKs and
  // strip the sealed owner's access, breaking the inalienability floor.
  if (callerKeyring.role === 'custodian') {
    throw new PermissionDeniedError(
      'custodian cannot rotate keys (FR-6: re-key is an owner-only meta-capability; use the Deed owner)',
    )
  }
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

/**
 * Change the user's passphrase. Re-wraps every DEK under the new KEK.
 *
 * Validates the new passphrase against the strength rules unless
 * `allowWeakPassphrase: true` is passed. Mirrors `rotatePassphrase`'s
 * default-on validation contract.
 *
 * `db.rotatePassphrase()` adds a `checkGate('rotate-passphrase')` step
 * on top of this primitive and additionally requires the OLD passphrase
 * for re-derivation; `changeSecret` reuses the cached unlocked KEK so
 * the OLD passphrase is not retyped.
 */
export async function changeSecret(
  adapter: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
  newPassphrase: string,
  passphraseOpts?: PassphrasePolicy & { allowWeakPassphrase?: boolean },
): Promise<UnlockedKeyring> {
  if (!passphraseOpts?.allowWeakPassphrase) {
    assertStrongPassphrase(newPassphrase, passphraseOpts)
  }
  const newSalt = generateSalt()
  const newKek = await deriveKey(newPassphrase, newSalt)

  // Re-wrap all DEKs with the new KEK
  const wrappedDeks: Record<string, string> = {}
  for (const [collName, dek] of keyring.deks) {
    wrappedDeks[collName] = await wrapKey(dek, newKek)
  }

  const canary = await mintKeyringCanary(newKek)
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
    canary,
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
    // Tier-2 slots are NOT preserved through `changeSecret` —
    // each slot wraps the OLD KEK, so the new keyring has no
    // authenticator slots until the user re-enrolls. The higher-level
    // `db.rotatePassphrase()` preserves slots by rewrapping the
    // KEK reference, not the KEK itself.
    authenticators: [],
    ...(keyring.policy !== undefined && { policy: keyring.policy }),
  }
}

// ─── Bundle recipients ──────────────────────────────────────────

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
  /**
   * Optional `as-*` import grants on the destination vault.
   * Mirrors the `importCapability` field on a live keyring.
   * Default-closed: no plaintext format granted, no bundle import.
   */
  readonly importCapability?: ImportCapability
  /**
   * Optional bundle-slot expiry. ISO-8601 timestamp; past the
   * cutoff this slot's keyring refuses to load with
   * `KeyringExpiredError`. Time-boxed audit access pattern: "this
   * slot works for 30 days then becomes opaque to its holder."
   */
  readonly expiresAt?: string
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
  if (!callerKeyring.kek) {
    throw new ValidationError(
      'buildRecipientKeyringFile: caller keyring has no KEK — tier-2 wrap-DEKs ' +
        'and tier-3 PIN-resume sessions cannot create bundle recipients. ' +
        'Re-authenticate at tier 1 (passphrase) before building a bundle.',
    )
  }

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

  // owner / admin / custodian / viewer: wrap every known DEK (matches grant).
  // FR-6: a custodian recipient operates every collection, so it receives all
  // DEKs just like admin (kept in lockstep with grant()'s all-DEKs branch).
  if (role === 'owner' || role === 'admin' || role === 'custodian' || role === 'viewer') {
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

  const canary = await mintKeyringCanary(newKek)
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
    canary,
    ...(recipient.exportCapability !== undefined
      ? { export_capability: recipient.exportCapability }
      : {}),
    ...(recipient.importCapability !== undefined
      ? { import_capability: recipient.importCapability }
      : {}),
    ...(recipient.expiresAt !== undefined
      ? { expires_at: recipient.expiresAt }
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

/**
 * Optional filter knobs for {@link listUsersWithEnvelopes}.
 *
 * - `includeHidden` — when true, principals with `_meta/visibility/<id>`
 *   set to `{ hidden: true }` are returned alongside everyone else.
 *   Requires `owner` or `admin` callerRole; lower roles get
 *   {@link import('../../kernel/errors.js').PermissionDeniedError}.
 */
export interface ListUsersOptions {
  readonly includeHidden?: boolean
}

/**
 * Joined enumeration: every keyring + its `_users/<keyringId>`
 * envelope side by side. Convenience for admin UIs that want to
 * render team-member lists with profile data ("Bob — operator —
 * 'Bob the Auditor' avatar X locale fr-FR") in a single pass.
 *
 * `userEnvelopeDek` is the vault's `_users` collection DEK
 * (`vault.getDEK('_users')`); used to decrypt every envelope.
 *
 * `callerRole` drives the directory-visibility checks:
 *
 *  - When the vault's `_meta/directory` document has `enabled: false`,
 *    only `owner` and `admin` callers may enumerate; anyone else gets
 *    {@link import('../../kernel/errors.js').DirectoryDisabledError}.
 *  - Principals with `_meta/visibility/<id>` set to `{ hidden: true }`
 *    are filtered out by default. `owner`/`admin` callers can pass
 *    `{ includeHidden: true }` to see them; lower roles passing that
 *    option get `PermissionDeniedError`.
 *
 * Honest caveat: these filters are a UX hint, not a security
 * boundary. The keyring file is still listed at `_keyring/*` and the
 * envelope ciphertext at `_users/*`. A caller with direct store access
 * — or a caller that calls this function with `callerRole: 'owner'`
 * unconditionally — sees every principal. The protection is only as
 * strong as the role the calling layer passes in. The hub-level wrapper
 * on `Vault` sources `callerRole` from the unlocked keyring's `role`
 * field, which is signed-by-construction (it lives in the user's own
 * keyring file). See `docs/subsystems/user-envelope.md` →
 * "Directory visibility".
 *
 * Principals without a persisted envelope (legacy keyrings predating
 * the user-envelope feature) come back with `envelope: null`. The
 * caller chooses how to render — usually "fall back to keyring's
 * `displayName`".
 *
 * Order matches `listUsers()` (store-defined; sort if you need a
 * stable display order).
 */
export async function listUsersWithEnvelopes<T = unknown>(
  adapter: NoydbStore,
  vault: string,
  userEnvelopeDek: CryptoKey,
  callerRole: Role,
  options: ListUsersOptions = {},
): Promise<Array<{ user: UserInfo; envelope: UserEnvelopeReader<T> | null }>> {
  // FR-6: custodian is INTENTIONALLY treated as NON-privileged here (SAFER
  // default — review flag). Directory-privilege is a team-MANAGEMENT capability
  // (bypassing the visibility toggle + listing hidden principals); a custodian
  // is non-owning and cannot grant/revoke, so it should not see the hidden
  // team membership. It still gets the normal (non-hidden) directory view.
  const isPrivileged = callerRole === 'owner' || callerRole === 'admin'

  // 1. Vault-level directory toggle.
  const dirConfig = await readDirectoryConfig(adapter, vault)
  if (dirConfig?.enabled === false && !isPrivileged) {
    throw new DirectoryDisabledError(vault)
  }

  // 2. `includeHidden` requires admin/owner.
  if (options.includeHidden && !isPrivileged) {
    throw new PermissionDeniedError(
      'Permission denied — listUsersWithEnvelopes({ includeHidden: true }) requires owner or admin role',
    )
  }

  const users = await listUsers(adapter, vault)
  const out: Array<{ user: UserInfo; envelope: UserEnvelopeReader<T> | null }> = []
  for (const user of users) {
    if (!options.includeHidden) {
      const visibility = await readUserVisibility(adapter, vault, user.userId)
      if (visibility?.hidden) continue
    }
    const envelope = await loadUserEnvelopeFn<T>(
      adapter,
      vault,
      user.userId,
      userEnvelopeDek,
    )
    out.push({ user, envelope })
  }
  return out
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
  // Pre-existing race exposed by the multi-writer ledger work.
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
  // FR-6: custodian writes every collection (admin-level operational rw).
  if (keyring.role === 'owner' || keyring.role === 'admin' || keyring.role === 'custodian') return true
  if (keyring.role === 'viewer' || keyring.role === 'client') return false
  return keyring.permissions[collectionName] === 'rw'
}

/** Check if a user has any access to a collection. */
export function hasAccess(keyring: UnlockedKeyring, collectionName: string): boolean {
  // FR-6: custodian reads every collection (admin-level operational access).
  if (
    keyring.role === 'owner' ||
    keyring.role === 'admin' ||
    keyring.role === 'custodian' ||
    keyring.role === 'viewer'
  )
    return true
  return collectionName in keyring.permissions
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** Persist a keyring file to the adapter. */
export async function persistKeyring(
  adapter: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
): Promise<void> {
  if (!keyring.kek) {
    throw new ValidationError(
      'persistKeyring: keyring.kek is null — cannot wrap DEKs without the KEK. ' +
        'This typically means the keyring was opened via tier-3 PIN resume, ' +
        'session restore, or a wrap-DEKs tier-2 unlock. Re-authenticate at ' +
        'tier 1 (passphrase) before persisting.',
    )
  }
  const wrappedDeks: Record<string, string> = {}
  for (const [collName, dek] of keyring.deks) {
    wrappedDeks[collName] = await wrapKey(dek, keyring.kek)
  }
  const canary = await mintKeyringCanary(keyring.kek)

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
    canary,
    ...(keyring.exportCapability !== undefined && { export_capability: keyring.exportCapability }),
    ...(keyring.importCapability !== undefined && { import_capability: keyring.importCapability }),
    ...(keyring.authenticators.length > 0 && { authenticators: keyring.authenticators }),
    ...(keyring.policy !== undefined && { policy: keyring.policy }),
  }

  await writeKeyringFile(adapter, vault, keyring.userId, keyringFile)
}

// ─── Export capability ──────────────────────────────────────

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
  // FR-6: custodian is INTENTIONALLY not in the default-true set (SAFER
  // default — review flag). A bundle is an external artifact that outlives
  // keyring revocation; the owner can still grant a custodian
  // `exportCapability.bundle = true` explicitly when an offline backup is
  // part of the custody contract. Defaulting it off keeps a custodian from
  // silently minting a revocation-surviving copy of the whole vault.
  return role === 'owner' || role === 'admin'
}

/**
 * Check whether a keyring is authorised for a given `@noy-db/as-*`
 * export tier.
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

// ─── Import capability (issue ) ────────────────────────────────────

/**
 * Check whether a keyring is authorised for a given `@noy-db/as-*`
 * import tier (issue ).
 *
 * - `tier: 'plaintext'` — true iff `importCapability.plaintext`
 *   contains the requested `format` or the `'*'` wildcard.
 * - `tier: 'bundle'` — true iff `importCapability.bundle === true`.
 *
 * **Default-closed for every role on every dimension** — including
 * owner. Import is more dangerous than export (corrupts vs leaks), so
 * the policy refuses to assume intent. Owners must positively grant
 * the capability via `vault.grant({ importCapability: ... })`.
 */
export function hasImportCapability(
  keyring: UnlockedKeyring,
  tier: 'plaintext',
  format: ExportFormat,
): boolean
export function hasImportCapability(
  keyring: UnlockedKeyring,
  tier: 'bundle',
): boolean
export function hasImportCapability(
  keyring: UnlockedKeyring,
  tier: 'plaintext' | 'bundle',
  format?: ExportFormat,
): boolean {
  const cap = keyring.importCapability
  if (tier === 'plaintext') {
    const allowed = cap?.plaintext ?? []
    return allowed.includes('*') || (format !== undefined && allowed.includes(format))
  }
  // tier === 'bundle' — closed default for every role
  return cap?.bundle === true
}

/**
 * Same-shape inspector for an `ImportCapability` value that isn't yet
 * attached to a keyring (e.g. previewing a grant before applying).
 * `role` is accepted for symmetry with `evaluateExportCapability` even
 * though the import policy ignores it — bundle defaults are
 * role-agnostic and closed.
 */
export function evaluateImportCapability(
  capability: ImportCapability | undefined,
  role: Role,
  tier: 'plaintext',
  format: ExportFormat,
): boolean
export function evaluateImportCapability(
  capability: ImportCapability | undefined,
  role: Role,
  tier: 'bundle',
): boolean
export function evaluateImportCapability(
  capability: ImportCapability | undefined,
  _role: Role,
  tier: 'plaintext' | 'bundle',
  format?: ExportFormat,
): boolean {
  if (tier === 'plaintext') {
    const allowed = capability?.plaintext ?? []
    return allowed.includes('*') || (format !== undefined && allowed.includes(format))
  }
  return capability?.bundle === true
}

function resolvePermissions(role: Role, explicit?: Permissions): Permissions {
  // FR-6: custodian is full-access-by-role (hasAccess/hasWritePermission
  // short-circuit on the role), so — like admin — its permissions map is
  // empty. Returning {} also prevents a caller-supplied `permissions` from
  // accidentally NARROWING a custodian below its role guarantee.
  if (role === 'owner' || role === 'admin' || role === 'custodian' || role === 'viewer') return {}
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
