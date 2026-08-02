import type { NoydbStore, KeyringFile, KeyringAuthenticator, Role, Permissions, GrantOptions, RevokeOptions, UpdateUserOptions, UserInfo, EncryptedEnvelope, ExportCapability, ExportFormat, ImportCapability, VaultPolicyOnDisk, UserEnvelope } from '../../kernel/types.js'
import { NOYDB_KEYRING_VERSION, NOYDB_FORMAT_VERSION } from '../../kernel/types.js'
import { USER_ENVELOPE_COLLECTION } from '../../kernel/constants.js'
import {
  deriveKey,
  deriveEchoKey,
  generateDEK,
  generateSalt,
  wrapKey,
  unwrapKey,
  encrypt,
  decrypt,
  bufferToBase64,
  base64ToBuffer,
  type EnclaveKey,
  type EchoSecretParts,
} from '../../kernel/enclave/index.js'
import { NoAccessError, PermissionDeniedError, PrivilegeEscalationError, KeyringExpiredError, KeyringCorruptError, InvalidKeyError, ValidationError, DirectoryDisabledError, EchoCeremonyRequiredError } from '../../kernel/errors.js'
import { readDirectoryConfig } from '../directory/storage.js'
import { readUserVisibility, deleteUserVisibility } from '../directory/visibility.js'
import {
  assertStrongSecret,
  assertStrongEchoSecret,
  type SecretPolicy,
  type EchoSecretPolicy,
} from '../../kernel/validation.js'
import { buildEchoBlock } from './echo-secret.js'
import type { DeviceSealProvider } from './device-seal.js'
import {
  saveUserEnvelope,
  loadUserEnvelope as loadUserEnvelopeFn,
  deleteUserEnvelope,
} from '../directory/user-envelope/index.js'
import { isSecretBearingReservedCollection } from './reserved-secret-collections.js'

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
  readonly deks: Map<string, EnclaveKey>
  /**
   * The KEK, when this keyring was unlocked via tier 1 (secret) or
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
   * Tightened from `EnclaveKey` to `EnclaveKey | null`; the runtime
   * contract has always allowed null, the type now matches reality.
   */
  readonly kek: EnclaveKey | null
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

// ─── Secret canary ─────────────────────────────────────────────────
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
// this distinguishes wrong-secret (canary fails AND every DEK fails)
// from corruption (canary succeeds OR at least one DEK succeeds) —
// closing the all-DEKs-corrupt and single-DEK ambiguities that the
// pre-canary heuristic left open.

const CANARY_PLAINTEXT_BYTES = new Uint8Array(32)
let canaryKeyPromise: Promise<EnclaveKey> | null = null

function getCanaryKey(): Promise<EnclaveKey> {
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
export async function mintKeyringCanary(kek: EnclaveKey): Promise<string> {
  const canaryKey = await getCanaryKey()
  return wrapKey(canaryKey, kek)
}

/** Try to unwrap the canary. Returns true iff KEK + canary bytes are intact. */
async function verifyKeyringCanary(wrappedCanary: string, kek: EnclaveKey): Promise<boolean> {
  try {
    await unwrapKey(wrappedCanary, kek)
    return true
  } catch {
    return false
  }
}

// ─── Load / Create ─────────────────────────────────────────────────────

/** Options for {@link loadKeyring} (#846b). */
export interface LoadKeyringOptions {
  /** The user whose keyring to unlock. */
  readonly userId: string
  /**
   * That user's secret — a single string for a standard keyring, or the
   * structured 3-part {@link EchoSecretParts} for an echo keyring (spec
   * #940, AG-1: a single string can never unlock an echo keyring).
   */
  readonly secret: string | EchoSecretParts
}

/**
 * KDF dispatch for tier-1 unlock (spec #940). An echo keyring accepts
 * ONLY structured parts (AG-1 — no single string is key-equivalent);
 * a standard keyring accepts only a string.
 */
export async function deriveKekForKeyring(
  file: KeyringFile,
  secret: string | EchoSecretParts,
  salt: Uint8Array,
): Promise<EnclaveKey> {
  if (file.echo !== undefined) {
    if (typeof secret === 'string') throw new EchoCeremonyRequiredError()
    return deriveEchoKey(secret, salt)
  }
  if (typeof secret !== 'string') {
    throw new ValidationError('This keyring uses a standard secret — pass a string, not echo parts.')
  }
  return deriveKey(secret, salt)
}

// ─── Raw keyring reads (#951) ───────────────────────────────────────────
//
// Single sanctioned reader of a keyring file's `_data`, plus the fetch+parse
// and expiry-gate wrappers built on it. Every keyring.ts / echo-ceremony.ts
// call site that used to inline `JSON.parse(env._data) as KeyringFile`
// (each with its own missing-row semantics — throw / skip / continue) now
// goes through `readKeyringFile`, which stays neutral on the missing-row
// case (`undefined`) and lets each caller keep its own decision.

/** Parse a raw keyring envelope. Single sanctioned reader of `_data` for keyring files. */
export function parseKeyringEnvelope(envelope: EncryptedEnvelope): KeyringFile {
  return JSON.parse(envelope._data) as KeyringFile
}

/** Fetch + parse a user's keyring file; undefined when the row is missing. */
export async function readKeyringFile(
  store: NoydbStore,
  vault: string,
  userId: string,
): Promise<{ readonly envelope: EncryptedEnvelope; readonly file: KeyringFile } | undefined> {
  const envelope = await store.get(vault, '_keyring', userId)
  if (!envelope) return undefined
  return { envelope, file: parseKeyringEnvelope(envelope) }
}

/**
 * Shared expiry gate — refuse to unwrap an expired slot. Call before any
 * KEK derivation so an expired slot doesn't leak timing on the secret.
 * Comparison uses Date.parse → ms-since-epoch; an unparseable expires_at is
 * treated as "no expiry" so a malformed value can't silently lock users out
 * (it'll surface in tests).
 */
export function assertKeyringNotExpired(file: KeyringFile): void {
  if (file.expires_at !== undefined) {
    const cutoff = Date.parse(file.expires_at)
    if (Number.isFinite(cutoff) && Date.now() >= cutoff) {
      throw new KeyringExpiredError({ userId: file.user_id, expiresAt: file.expires_at })
    }
  }
}

/** Load and unlock a user's keyring for a vault. */
export async function loadKeyring(
  store: NoydbStore,
  vault: string,
  opts: LoadKeyringOptions,
): Promise<UnlockedKeyring> {
  const { userId, secret } = opts
  const found = await readKeyringFile(store, vault, userId)

  if (!found) {
    throw new NoAccessError(`No keyring found for user "${userId}" in vault "${vault}"`)
  }

  const { file: keyringFile } = found

  assertKeyringNotExpired(keyringFile)

  const salt = base64ToBuffer(keyringFile.salt)
  const kek = await deriveKekForKeyring(keyringFile, secret, salt)

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
  const deks = new Map<string, EnclaveKey>()
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
 * Open-policy pre-gate: decide create-vs-fail-closed **before** any
 * vault write. `openVault` must not self-provision an owner keyring into a
 * vault held by other principals; create-on-open is allowed only for a
 * genuinely-new vault (no `_keyring/*` at all). Capability-free — one
 * `store.list`. Returns when the open may proceed (the caller is a member, or
 * the vault is genuinely-new and `create` is allowed, in which case the caller
 * falls through to the normal `createOwnerKeyring` path); throws `NoAccessError`
 * otherwise. Placed before managed-secret secret resolution (which persists
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
 * Options for {@link createOwnerKeyring} (#846b). The `SecretPolicy` knobs are
 * flattened into the same bag rather than nested, so `assertStrongSecret` can
 * take `opts` directly.
 */
export interface CreateOwnerKeyringOptions extends SecretPolicy {
  /** The owner to create. */
  readonly userId: string
  /**
   * The owner's secret — a plain string for a standard keyring, or the
   * structured 3-part {@link EchoSecretParts} to enroll an echo keyring
   * (spec #940). The shape alone selects the KDF and whether an `echo`
   * block is written.
   */
  readonly secret: string | EchoSecretParts
  /** Gate creation on the phrase-format strength rules. Default false. */
  readonly validate?: boolean
  /** Escape hatch for fixtures and migrations — skips the strength gate. */
  readonly allowWeakSecret?: boolean
  /**
   * Echo enrollment only: device-local sealer for the reveal blob. Present
   * ⇒ `reveal: 'sealed'` (attacker-B resistance); absent ⇒ `reveal:
   * 'portable'` (spec resolved question 4). Ignored for a string secret.
   */
  readonly deviceSeal?: DeviceSealProvider
  /** Echo enrollment only: optional display hint for the masked echo. */
  readonly echoMaskHint?: string
  /**
   * Echo enrollment only: strength-policy knobs for the 3-part secret's
   * prompt / combined floors — the parts-path counterpart of the
   * flattened `SecretPolicy` fields this options bag already extends
   * (those apply to a STRING secret via `assertStrongSecret`; this
   * applies to {@link EchoSecretParts} via `assertStrongEchoSecret`).
   * Ignored for a string secret.
   */
  readonly echoSecretPolicy?: EchoSecretPolicy
}

/**
 * Create the initial owner keyring for a new vault.
 *
 * Pass `{ validate: true }` (or any `SecretPolicy` knob) to gate creation
 * on the phrase-format strength rules — `Noydb` threads this from
 * `NoydbOptions.validateSecret`. Direct callers (CLI, scripts,
 * test fixtures) opt in explicitly.
 */
export async function createOwnerKeyring(
  store: NoydbStore,
  vault: string,
  opts: CreateOwnerKeyringOptions,
): Promise<UnlockedKeyring> {
  const { userId, secret } = opts
  if (opts.validate && !opts.allowWeakSecret) {
    // `buildEchoBlock` only type-validates the 3-part secret via the
    // `encodeEchoParts` chokepoint — the STRENGTH gate for it still has to
    // fire here, exactly like `assertStrongSecret` does for a string.
    if (typeof secret === 'string') assertStrongSecret(secret, opts)
    else {
      assertStrongEchoSecret(secret, {
        ...opts.echoSecretPolicy,
        ...(opts.allowWeakSecret !== undefined && { allowWeakSecret: opts.allowWeakSecret }),
      })
    }
  }
  const salt = generateSalt()
  const kek = typeof secret === 'string'
    ? await deriveKey(secret, salt)
    : await deriveEchoKey(secret, salt)

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
    // The presence of this block is what makes the keyring an echo keyring —
    // `deriveKekForKeyring` reads it to refuse a single-string unlock (AG-1).
    ...(typeof secret !== 'string'
      ? {
          echo: await buildEchoBlock(
            secret,
            opts.deviceSeal ? { kind: 'sealed', deviceSeal: opts.deviceSeal } : { kind: 'portable' },
            opts.echoMaskHint,
          ),
        }
      : {}),
  }

  await writeKeyringFile(store, vault, userId, keyringFile)

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
  store: NoydbStore,
  vault: string,
  callerKeyring: UnlockedKeyring,
  options: GrantOptions,
): Promise<void> {
  if (!callerKeyring.kek) {
    throw new ValidationError(
      'grant: caller keyring has no KEK — tier-2 wrap-DEKs and tier-3 PIN-resume ' +
        'sessions cannot grant access to other users. Re-authenticate at tier 1 ' +
        '(secret) before granting.',
    )
  }

  if (!canGrant(callerKeyring.role, options.role)) {
    throw new PermissionDeniedError(
      `Role "${callerKeyring.role}" cannot grant role "${options.role}"`,
    )
  }

  // Optional strength validation — opt-in via grant({ validateSecret: true })
  // or via the calling Noydb's NoydbOptions.validateSecret flag.
  // The override `allowWeakSecret: true` skips even when validate is on.
  if (
    (options as { validateSecret?: boolean }).validateSecret &&
    !options.allowWeakSecret
  ) {
    assertStrongSecret(options.secret)
  }

  // Determine which collections the new user gets access to
  const permissions = resolvePermissions(options.role, options.permissions)

  // Derive the new user's KEK from their secret
  const newSalt = generateSalt()
  const newKek = await deriveKey(options.secret, newSalt)

  // Only owner and admin may ever hold a secret-bearing reserved DEK
  // (`_sync_credentials`, `_broker`) — they are the roles the dedicated
  // credential API admits. Every other grantee (custodian, viewer, operator,
  // client) is excluded, even from the "wrap ALL" branches below: a custodian
  // operates the DATA but must never read the firm's transport secrets (see
  // `requireAdminAccess` in sync-credentials.ts), and handing any sub-admin
  // one of these DEKs is a plaintext leak, not a metadata leak.
  const granteeMayHoldSecrets =
    options.role === 'owner' || options.role === 'admin'

  // Wrap the appropriate DEKs with the new user's KEK
  const wrappedDeks: Record<string, string> = {}
  for (const collName of Object.keys(permissions)) {
    // Never hand a secret-bearing reserved DEK to a sub-admin, even if the
    // grantor explicitly names it in `permissions` — that path is served
    // only by the owner/admin-gated credential API, not per-collection grants.
    if (isSecretBearingReservedCollection(collName) && !granteeMayHoldSecrets) continue
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
      if (collName in wrappedDeks) continue
      if (isSecretBearingReservedCollection(collName) && !granteeMayHoldSecrets) continue
      wrappedDeks[collName] = await wrapKey(dek, newKek)
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
  //
  // EXCEPTION — secret-bearing reserved collections (`_sync_credentials`,
  // `_broker`) whose record CONTENTS are directly-usable secrets are NOT
  // propagated to sub-admin grantees. Unlike the operational collections
  // above, handing an operator/viewer/client/custodian one of these DEKs
  // IS a plaintext leak (the firm's transport OAuth tokens). Only owner and
  // admin — the roles the dedicated `getCredential`/`putCredential` API
  // admits — receive them, so the legit admin-reads-existing-credential
  // flow (which needs the DEK to decrypt, not regenerate) still works.
  for (const [collName, dek] of callerKeyring.deks) {
    if (!collName.startsWith('_') || collName in wrappedDeks) continue
    if (isSecretBearingReservedCollection(collName) && !granteeMayHoldSecrets) continue
    wrappedDeks[collName] = await wrapKey(dek, newKek)
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

  await writeKeyringFile(store, vault, options.userId, keyringFile)

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
      store,
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
  store: NoydbStore,
  vault: string,
  rootUserId: string,
): Promise<string[]> {
  const allUserIds = await store.list(vault, '_keyring')

  // Build a map: parentUserId → child KeyringFiles. We only ever
  // descend into admins, so non-admin children are skipped at the
  // edge level rather than after a recursive call.
  const childrenByParent = new Map<string, string[]>()
  for (const userId of allUserIds) {
    const found = await readKeyringFile(store, vault, userId)
    if (!found) continue
    const kf = found.file
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
  store: NoydbStore,
  vault: string,
  callerKeyring: UnlockedKeyring,
  options: RevokeOptions,
): Promise<void> {
  // Load the target's keyring to check their role
  const targetFound = await readKeyringFile(store, vault, options.userId)
  if (!targetFound) {
    throw new NoAccessError(`User "${options.userId}" has no keyring in vault "${vault}"`)
  }

  const targetKeyring = targetFound.file

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
    const descendants = await findAdminDescendants(store, vault, options.userId)
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
          const descFound = await readKeyringFile(store, vault, userId)
          if (!descFound) continue
          usersToRevoke.push(userId)
          for (const c of Object.keys(descFound.file.deks)) affectedCollections.add(c)
        }
      }
    }
  }

  // Delete every keyring in the revoke set. Order doesn't matter
  // because each keyring file is independent on disk; we don't have
  // referential integrity to maintain across deletes.
  for (const userId of usersToRevoke) {
    await store.delete(vault, '_keyring', userId)
    // Cascade-delete the principal's user envelope. Idempotent — no
    // error when the envelope was never written (e.g. the user was
    // granted but never authenticated to write their own profile).
    await deleteUserEnvelope(store, vault, userId)
    // Also drop the visibility sidecar at `_meta/visibility/<userId>`.
    // If the same `userId` is re-granted later (rare for humans,
    // possible for service accounts and test fixtures), the new
    // principal must start with a fresh visibility state instead of
    // silently inheriting the revoked user's `hidden` flag.
    await deleteUserVisibility(store, vault, userId)
  }

  // Single rotation pass at the end. The cost is O(records in
  // affected collections), NOT O(records × cascade depth) — every
  // descendant's collections were unioned into `affectedCollections`
  // before we got here, so the rotation re-encrypts each affected
  // record exactly once regardless of how deep the cascade went.
  if (options.rotateKeys !== false && affectedCollections.size > 0) {
    await rotateKeys(store, vault, callerKeyring, { collections: [...affectedCollections] })
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
  store: NoydbStore,
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

  const found = await readKeyringFile(store, vault, options.userId)
  if (!found) {
    throw new NoAccessError(
      `updateUser: user "${options.userId}" has no keyring in vault "${vault}".`,
    )
  }
  const target = found.file

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

  await writeKeyringFile(store, vault, options.userId, next)
}

// ─── Key Rotation ──────────────────────────────────────────────────────

/**
 * Rotate DEKs for specified collections:
 * 1. Generate new DEKs
 * 2. Re-encrypt all records in affected collections
 * 3. Re-wrap new DEKs for all remaining users
 */
/**
 * What a DEK rotation leaves behind (#854).
 *
 * A member's DEKs are wrapped under that member's KEK, and a KEK derives only
 * from that member's secret — so the caller cannot re-wrap a fresh DEK for
 * anyone else. That is the zero-knowledge property working as designed, but it
 * means rotation necessarily DROPS the rotated collections from every other
 * member's keyring rather than re-keying them.
 *
 * `needsRegrant` names exactly who lost what, so the caller can re-run
 * `grant()` instead of discovering the access loss later.
 */
export interface RotateResult {
  /** (member, collection) pairs whose access was dropped by the rotation. */
  readonly needsRegrant: ReadonlyArray<{ readonly userId: string; readonly collection: string }>
}

/** Options for {@link rotateKeys} (#846b — was a bare `string[]`). */
export interface RotateKeysOptions {
  /** Collections whose DEKs are re-minted. */
  readonly collections: readonly string[]
}

export async function rotateKeys(
  store: NoydbStore,
  vault: string,
  callerKeyring: UnlockedKeyring,
  opts: RotateKeysOptions,
): Promise<RotateResult> {
  const { collections } = opts
  // FR-6: re-keying is an owner-only meta-capability. A custodian operates the
  // vault fully but must NOT rotate — rotation would let it mint fresh DEKs and
  // strip the sealed owner's access, breaking the inalienability floor.
  if (callerKeyring.role === 'custodian') {
    throw new PermissionDeniedError(
      'custodian cannot rotate keys (FR-6: re-key is an owner-only meta-capability; use the Deed owner)',
    )
  }
  // Generate new DEKs for each affected collection
  const newDeks = new Map<string, EnclaveKey>()
  for (const collName of collections) {
    newDeks.set(collName, await generateDEK())
  }

  // Re-encrypt all records in affected collections
  //
  // FORWARD REQUIREMENT (not implemented here — DEK rotation predates
  // perRecordKeys/classified fields): a future perRecordKeys-aware DEK
  // rotation MUST DROP `_bidx` here rather than carry it forward. `_bidx` is
  // rooted in the (soon-to-be-dead) old DEK; a stale tag surviving under the
  // new DEK is unreturnable garbage (no key can ever re-derive it to match a
  // query again) that still LEAKS the old equality partition. Unlike
  // `rotateRecordCek` (record-keys/sealing.ts), which carries `_bidx`
  // verbatim because it is CEK-rotation-only and the DEK is unchanged, a DEK
  // rotation changes the root the tag is derived from, so index coverage can
  // only regrow per-record, the next time each record is `put()` under the
  // new DEK.
  //
  // D-5 (pre-existing hazard, flagged not fixed): in a mixed collection, bare
  // (non-`_cek`) records below are re-encrypted and `put()` in this loop
  // *before* any `_cek` record is reached; if a later record in the same
  // collection throws (e.g. an unwrap failure), those already-rewritten bare
  // records are left persisted under the new DEK while `callerKeyring` is
  // never updated with it (the `deks.set` below hasn't run) — an unsaved-DEK
  // state with no rollback.
  for (const collName of collections) {
    const oldDek = callerKeyring.deks.get(collName)
    const newDek = newDeks.get(collName)!
    if (!oldDek) continue

    const ids = await store.list(vault, collName)
    for (const id of ids) {
      const envelope = await store.get(vault, collName, id)
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
      await store.put(vault, collName, id, newEnvelope)
    }
  }

  // Update caller's keyring with new DEKs
  for (const [collName, newDek] of newDeks) {
    callerKeyring.deks.set(collName, newDek)
  }
  await persistKeyring(store, vault, callerKeyring)

  // Drop the rotated collections from every OTHER member's keyring.
  //
  // The old comment here said these were "re-wrapped", which is what
  // `Noydb.rotate`'s jsdoc promised too — but re-wrapping is impossible and
  // always was (#854). See the note below.
  const needsRegrant: Array<{ userId: string; collection: string }> = []
  const userIds = await store.list(vault, '_keyring')
  for (const userId of userIds) {
    if (userId === callerKeyring.userId) continue

    const userFound = await readKeyringFile(store, vault, userId)
    if (!userFound) continue

    const userKeyringFile = userFound.file
    // A user's DEKs are wrapped with that user's KEK, and a KEK derives only
    // from the user's secret — the caller can never derive another user's
    // KEK, so re-wrapping the new DEKs for them is impossible. Rotation
    // therefore REMOVES the rotated collections' DEK entries (and permissions)
    // from each remaining user's keyring: secure (revoked keys are gone) but
    // the owner must re-run grant() for those users/collections.

    const updatedDeks = { ...userKeyringFile.deks }
    const updatedPermissions = { ...userKeyringFile.permissions }
    for (const collName of collections) {
      // Report only what the member actually held — a user who never had the
      // collection does not "need a re-grant".
      if (collName in updatedDeks || collName in updatedPermissions) {
        needsRegrant.push({ userId, collection: collName })
      }
      delete updatedDeks[collName]
      delete updatedPermissions[collName]
    }

    const updatedKeyring: KeyringFile = {
      ...userKeyringFile,
      deks: updatedDeks,
      permissions: updatedPermissions,
    }

    await writeKeyringFile(store, vault, userId, updatedKeyring)
  }

  return { needsRegrant }
}

// ─── Change Secret ─────────────────────────────────────────────────────

/** Options for {@link changeSecret} (#846b). */
export interface ChangeSecretOptions extends SecretPolicy {
  /** The replacement secret. */
  readonly newSecret: string
  /** Escape hatch for fixtures and migrations — skips the strength gate. */
  readonly allowWeakSecret?: boolean
}

/**
 * Change the user's secret. Re-wraps every DEK under the new KEK.
 *
 * Validates the new secret against the strength rules unless
 * `allowWeakSecret: true` is passed. Mirrors `rotateSecret`'s
 * default-on validation contract.
 *
 * `db.team.rotateSecret()` adds a `checkGate('rotate-secret')` step
 * on top of this primitive and additionally requires the OLD secret
 * for re-derivation; `changeSecret` reuses the cached unlocked KEK so
 * the OLD secret is not retyped.
 */
export async function changeSecret(
  store: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
  opts: ChangeSecretOptions,
): Promise<UnlockedKeyring> {
  // An echo keyring rotates via `rotateSecret` only — `changeSecret`
  // rebuilds the keyring file literal below and would silently DROP the
  // `echo` block, permanently losing the ceremony. Guard on the file as
  // persisted (not `keyring`, which carries no echo info) before any
  // derivation.
  const existingFound = await readKeyringFile(store, vault, keyring.userId)
  if (existingFound && existingFound.file.echo !== undefined) throw new EchoCeremonyRequiredError()

  const { newSecret } = opts
  if (!opts.allowWeakSecret) {
    assertStrongSecret(newSecret, opts)
  }
  const newSalt = generateSalt()
  const newKek = await deriveKey(newSecret, newSalt)

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

  await writeKeyringFile(store, vault, keyring.userId, keyringFile)

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
    // `db.team.rotateSecret()` preserves slots by rewrapping the
    // KEK reference, not the KEK itself.
    authenticators: [],
    ...(keyring.policy !== undefined && { policy: keyring.policy }),
  }
}

// ─── Bundle recipients ──────────────────────────────────────────

/**
 * Echo-mode recipient secret (spec #940). A pod slot may embed the reveal
 * (`'portable'`, default) or omit it (`'none'`) — `'sealed'` is
 * live-device-only and unavailable here: `writePod` has no device context
 * to seal the reveal blob against.
 */
export interface EchoRecipientSecret extends EchoSecretParts {
  readonly reveal?: 'portable' | 'none'
}

/**
 * Recipient slot in a re-keyed `.noydb` bundle. Each slot becomes its
 * own keyring file inside the bundle, sealed with its own secret.
 * Same role/permission semantics as `db.grant()` but no store side
 * effect — the slot only exists inside the bundle bytes.
 *
 * @public
 */
export interface BundleRecipient {
  /** User id stamped onto the keyring file in the bundle. */
  readonly id: string
  /** Optional display name. Defaults to `id`. */
  readonly displayName?: string
  /**
   * Secret the recipient will type to unlock — a plain string for a
   * standard keyring, or the structured 3-part {@link EchoRecipientSecret}
   * to embed an echo keyring so the anti-phishing ceremony travels with
   * the pod (spec #940).
   */
  readonly secret: string | EchoRecipientSecret
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
 * vault's unwrapped DEKs. Mirrors `grant()` minus the store write —
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
        'Re-authenticate at tier 1 (secret) before building a bundle.',
    )
  }

  const role: Role = recipient.role ?? 'viewer'
  const permissions = resolvePermissions(role, recipient.permissions)

  const newSalt = generateSalt()
  const newKek = typeof recipient.secret === 'string'
    ? await deriveKey(recipient.secret, newSalt)
    : await deriveEchoKey(recipient.secret, newSalt)

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
    // The presence of this block is what makes the recipient's slot an
    // echo keyring — mirrors `createOwnerKeyring`'s same dance so the
    // ceremony (prompt → echo → key) travels with the pod, not just a
    // live owner keyring.
    ...(typeof recipient.secret !== 'string'
      ? { echo: await buildEchoBlock(recipient.secret, { kind: recipient.secret.reveal ?? 'portable' }) }
      : {}),
  }
}

// ─── List Users ────────────────────────────────────────────────────────

/** List all users with access to a vault. */
export async function listUsers(
  store: NoydbStore,
  vault: string,
): Promise<UserInfo[]> {
  const userIds = await store.list(vault, '_keyring')
  const users: UserInfo[] = []

  for (const userId of userIds) {
    const found = await readKeyringFile(store, vault, userId)
    if (!found) continue
    const kf = found.file
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
 * keyring file). See `https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/user-envelope.md` →
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
  store: NoydbStore,
  vault: string,
  userEnvelopeDek: EnclaveKey,
  callerRole: Role,
  options: ListUsersOptions = {},
): Promise<Array<{ user: UserInfo; envelope: UserEnvelope<T> | null }>> {
  // FR-6: custodian is INTENTIONALLY treated as NON-privileged here (SAFER
  // default — review flag). Directory-privilege is a team-MANAGEMENT capability
  // (bypassing the visibility toggle + listing hidden principals); a custodian
  // is non-owning and cannot grant/revoke, so it should not see the hidden
  // team membership. It still gets the normal (non-hidden) directory view.
  const isPrivileged = callerRole === 'owner' || callerRole === 'admin'

  // 1. Vault-level directory toggle.
  const dirConfig = await readDirectoryConfig(store, vault)
  if (dirConfig?.enabled === false && !isPrivileged) {
    throw new DirectoryDisabledError(vault)
  }

  // 2. `includeHidden` requires admin/owner.
  if (options.includeHidden && !isPrivileged) {
    throw new PermissionDeniedError(
      'Permission denied — listUsersWithEnvelopes({ includeHidden: true }) requires owner or admin role',
    )
  }

  const users = await listUsers(store, vault)
  const out: Array<{ user: UserInfo; envelope: UserEnvelope<T> | null }> = []
  for (const user of users) {
    if (!options.includeHidden) {
      const visibility = await readUserVisibility(store, vault, user.userId)
      if (visibility?.hidden) continue
    }
    const envelope = await loadUserEnvelopeFn<T>(
      store,
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
  store: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
): Promise<(collectionName: string) => Promise<EnclaveKey>> {
  // Dedupe concurrent first-time DEK creates per collection. Without
  // this, two concurrent `getDEK('foo')` calls both pass the `existing`
  // check (the Map is empty), both generate fresh DEKs, and the second
  // `set` overwrites the first — making any envelope encrypted with
  // the discarded DEK fail to decrypt later (TamperedError on read).
  // Pre-existing race exposed by the multi-writer ledger work.
  const inFlight = new Map<string, Promise<EnclaveKey>>()
  return async (collectionName: string): Promise<EnclaveKey> => {
    const existing = keyring.deks.get(collectionName)
    if (existing) return existing
    const pending = inFlight.get(collectionName)
    if (pending) return pending

    const promise = (async () => {
      const dek = await generateDEK()
      keyring.deks.set(collectionName, dek)
      await persistKeyring(store, vault, keyring)
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

/** Persist a keyring file to the store. */
export async function persistKeyring(
  store: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
): Promise<void> {
  if (!keyring.kek) {
    throw new ValidationError(
      'persistKeyring: keyring.kek is null — cannot wrap DEKs without the KEK. ' +
        'This typically means the keyring was opened via tier-3 PIN resume, ' +
        'session restore, or a wrap-DEKs tier-2 unlock. Re-authenticate at ' +
        'tier 1 (secret) before persisting.',
    )
  }
  // Carry the `echo` block forward (#940). This function rebuilds the file
  // from the `UnlockedKeyring`, which deliberately carries no echo info (same
  // rationale as the `changeSecret` guard), so it has to be read back off the
  // persisted file — otherwise the first DEK-provisioning write would drop it
  // and silently degrade an echo keyring into a standard one that no secret
  // shape can open (the KEK stays echo-derived).
  const existingFound = await readKeyringFile(store, vault, keyring.userId)
  const existingEcho = existingFound?.file.echo

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
    ...(existingEcho !== undefined && { echo: existingEcho }),
  }

  await writeKeyringFile(store, vault, keyring.userId, keyringFile)
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
  store: NoydbStore,
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
  await store.put(vault, '_keyring', userId, envelope)
}
