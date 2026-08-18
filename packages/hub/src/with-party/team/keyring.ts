import type { NoydbStore, KeyringFile, KeyringAuthenticator, Role, Permissions, GrantOptions, RevokeOptions, UpdateUserOptions, UserInfo, EncryptedEnvelope, ExportCapability, ExportFormat, ImportCapability, VaultPolicyOnDisk, UserEnvelope } from '../../kernel/types.js'
import { NOYDB_KEYRING_VERSION } from '../../kernel/types.js'
import { USER_ENVELOPE_COLLECTION, ROSTER_KEY_ID } from '../../kernel/constants.js'
import {
  buildRecordEnvelope,
  deriveKey,
  deriveEchoKey,
  generateDEK,
  generateSalt,
  wrapKey,
  unwrapKey,
  rekeyEnvelopeIfNeeded,
  rekeyBlobSet,
  bufferToBase64,
  base64ToBuffer,
  type EnclaveKey,
  type EchoSecretParts,
} from '../../kernel/enclave/index.js'
import { NoAccessError, PermissionDeniedError, PrivilegeEscalationError, KeyringExpiredError, KeyringCorruptError, KeyringTamperedError, InvalidKeyError, ValidationError, DirectoryDisabledError, EchoCeremonyRequiredError } from '../../kernel/errors.js'
import type { KeyringTamperedReason } from '../../kernel/errors.js'
import { mintRosterTag, assertRosterAuthenticated, assertRosterTagValid } from './roster-tag.js'
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
   * Unwrapped counterpart of {@link KeyringFile.pending_deks} — an
   * uncommitted rotation (#1074). Empty in the normal state.
   */
  readonly pendingDeks?: Map<string, EnclaveKey> | undefined
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

// ─── Roster key (#1096) ────────────────────────────────────────────
//
// The vault-wide key that authenticates each keyring file's plaintext
// AUTHORITY half. It lives in the DEK map under `ROSTER_KEY_ID` rather
// than in a field of its own, so it reaches every member through the
// channels a DEK already travels — grant's `_`-prefix propagation,
// `persistKeyring`, the wrapped-DEKs recovery blob, `peer-recover`, pod
// recipient slots, session tokens.

/**
 * The vault roster key held by this keyring, or `null` when the keyring
 * carries none.
 *
 * Null is expected on the resume-style paths (`kek: null` sessions, tier-3
 * PIN resume, plaintext mode) — none of which may write a keyring file.
 * Every stamping site null-guards this exactly as it guards `kek`: minting a
 * file without a verifiable `roster_tag` would be worse than refusing, since
 * it is indistinguishable on the next load from a store having stripped it.
 */
export function rosterKeyOf(keyring: UnlockedKeyring): EnclaveKey | null {
  return keyring.deks.get(ROSTER_KEY_ID) ?? null
}

/**
 * Shared wording for the stamping-site guards — mirrors the `kek` guard's shape.
 * Exported so every roster-stamping site in the hub raises ONE error with one
 * wording, rather than each hand-copying it (`peer-recover`, `liberate`).
 */
export function requireRosterKey(keyring: UnlockedKeyring, fn: string): EnclaveKey {
  const rosterKey = rosterKeyOf(keyring)
  if (!rosterKey) {
    throw new ValidationError(
      `${fn}: caller keyring has no vault roster key — cannot stamp a roster tag. ` +
        'This typically means the keyring was opened via tier-3 PIN resume, ' +
        'session restore, or a wrap-DEKs tier-2 unlock. Re-authenticate at ' +
        'tier 1 (secret) before writing a keyring.',
    )
  }
  return rosterKey
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

  // #1096 — the expiry gate MOVED below roster verification. `expires_at` is a
  // plaintext field, so gating on it first let a store forge a past date and
  // choose the error the user sees: `KeyringExpiredError` ("your access ran
  // out") instead of `KeyringTamperedError` ("your store is attacking you").
  // Fail-closed either way, but it is a lockout an operator would spend the
  // afternoon re-granting rather than investigating.
  //
  // The old ordering's rationale — skip the KDF for an expired slot so it
  // "doesn't leak timing on the secret" — does not survive the trade: PBKDF2
  // costs the same whether or not the secret is right, so the early exit
  // revealed expiry, not secret correctness. Doing the derivation costs an
  // expired slot 600K iterations and buys an honest error.

  const salt = base64ToBuffer(keyringFile.salt)
  const kek = await deriveKekForKeyring(keyringFile, secret, salt)

  // Verify the canary first when present. A canary success proves the
  // KEK is correct independent of any DEK byte — so subsequent DEK
  // unwrap failures are unambiguously corruption, not wrong-pass. A
  // canary failure with at least one DEK success indicates the KEK
  // is correct but the canary itself is corrupt.
  //
  // #1096 — the canary is REQUIRED. `=== undefined` stays reachable at
  // runtime despite the required type: this object was parsed from JSON a
  // store controls.
  //
  // ⚠️ An earlier version of this comment said an absent canary "is not an old
  // file, it is a store stripping the field". The POLICY that follows from it is
  // right — absence is refused either way — but the factual half was wrong, and
  // it is worth being exact because the error text depends on it. Canary-less
  // keyrings are a real population: `canary` was `?: string` through
  // `0.6.0-pre.19`, with its own doc saying older keyrings have none. We cannot
  // tell an old file from a stripped one, and (unlike #1103's record case, where
  // the benign state requires the DEK) no test can, because deleting a field
  // needs no key. So: refuse both, and say both in the message.
  if (keyringFile.canary === undefined) {
    throw new KeyringTamperedError({ userId, reason: 'canary-missing' })
  }
  const canaryOk = await verifyKeyringCanary(keyringFile.canary, kek)

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

  // #1074 — unwrap any uncommitted rotation key. Deliberately NOT folded into
  // `failedCollections`: a pending DEK that fails to unwrap means the
  // interrupted rotation cannot be resumed, which is worth surfacing on its own
  // terms, but it must not make an otherwise-healthy keyring read as corrupt.
  const pendingDeks = new Map<string, EnclaveKey>()
  for (const [collName, wrapped] of Object.entries(keyringFile.pending_deks ?? {})) {
    try {
      pendingDeks.set(collName, await unwrapKey(wrapped, kek))
    } catch {
      // Unresumable; `deks` still holds the pre-rotation key, so the records
      // the interrupted run had not reached remain readable.
    }
  }

  if (canaryOk) {
    // KEK proven correct by the canary. Any DEK failure is corruption.
    if (failedCollections.length > 0) {
      throw new KeyringCorruptError({ failedCollections, intactCount: deks.size })
    }
  } else {
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
  }

  // #1096 — ROSTER AUTHENTICATION. Deliberately AFTER the key epilogue: a
  // plain wrong secret must keep reporting as InvalidKeyError and must never
  // be announced to the user as an attack. Past this point the KEK is proven
  // correct and every DEK unwrapped, so anything wrong with the plaintext
  // authority half is the store's doing.
  //
  // Absence is an error, not a skip. The alternative — verify only when a
  // tag is present — lets a store opt out of the whole mechanism by deleting
  // a plaintext field, which is precisely the power this closes.
  // A present-but-damaged roster entry already threw as KeyringCorruptError
  // above, so `roster-key-missing` from here means genuinely absent.
  await assertRosterAuthenticated(keyringFile, deks, userId)

  // Now that `expires_at` is known to be the value an authorised editor wrote,
  // an expiry is genuinely an expiry. See the note at the top of this function.
  assertKeyringNotExpired(keyringFile)

  return {
    userId: keyringFile.user_id,
    displayName: keyringFile.display_name,
    role: keyringFile.role,
    permissions: keyringFile.permissions,
    deks,
    pendingDeks,
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
  // #1096 — the vault's roster key is minted exactly here, once, and reaches
  // every later member through grant's `_`-prefix DEK propagation.
  const rosterKey = await generateDEK()
  const wrappedRosterKey = await wrapKey(rosterKey, kek)
  const canary = await mintKeyringCanary(kek)

  const authority = {
    user_id: userId,
    display_name: userId,
    role: 'owner' as const,
    permissions: {},
    granted_by: userId,
  }
  const keyringFile: KeyringFile = {
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    ...authority,
    deks: {
      [USER_ENVELOPE_COLLECTION]: wrappedUserEnvelopeDek,
      [ROSTER_KEY_ID]: wrappedRosterKey,
    },
    salt: bufferToBase64(salt),
    created_at: new Date().toISOString(),
    canary,
    roster_tag: await mintRosterTag(authority, rosterKey),
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
    deks: new Map([
      [USER_ENVELOPE_COLLECTION, userEnvelopeDek],
      [ROSTER_KEY_ID, rosterKey],
    ]),
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
  const callerRosterKey = requireRosterKey(callerKeyring, 'grant')

  if (!canGrant(callerKeyring.role, options.role)) {
    throw new PermissionDeniedError(
      `Role "${callerKeyring.role}" cannot grant role "${options.role}"`,
    )
  }

  // PRESENCE check — distinct from, and unskippable by, the strength check
  // below. `GrantOptions.secret` is a required field, so only an untypechecked
  // call site can omit it (a build script outside the typecheck project, a
  // stale `passphrase` key surviving the 0.4.0-pre rename). Before #1004 that
  // call derived a KEK from `undefined`, minted a real keyring slot, and
  // surfaced as `InvalidKeyError` whenever the grantee first tried to unlock —
  // arbitrarily far from the call that caused it. Fail at the grant instead.
  // `allowWeakSecret` deliberately does NOT skip this: it waives the strength
  // POLICY, not the existence of a secret.
  const secret: unknown = options.secret
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new ValidationError(
      `grant: \`secret\` is required and must be a non-empty string (got ${
        secret === undefined ? 'undefined' : typeof secret === 'string' ? 'an empty string' : typeof secret
      }). The grantee's key is derived from it, so a missing secret produces a ` +
        'keyring slot nobody can unlock. Note the 0.4.0-pre rename: the option is ' +
        '`secret`, not `passphrase`.',
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

  // A grantee's DEKs can only ever be wrapped HERE, at grant time: wrapping
  // needs the grantee's KEK, which is derived from a secret the vault never
  // stores, so there is no later moment at which a newly-minted collection DEK
  // could be back-filled into an existing keyring. #1004: granting
  // `{ invoices: 'rw' }` before `invoices` existed therefore wrapped nothing
  // and left a permanently blind slot. Mint the DEK now so the grant is
  // honoured whichever order the caller works in.
  //
  // Only for collections that do not exist yet. If a collection HAS records
  // and the grantor still lacks its DEK, minting would fabricate a key that
  // decrypts nothing AND would hand the anti-privilege-escalation check below
  // a DEK the grantor never legitimately held — turning a structural guarantee
  // into a no-op. Leave those unwrapped and let the read path deny.
  let mintedForGrant = false
  for (const collName of Object.keys(permissions)) {
    // `'*'` is a marker, not a collection — minting a DEK for it would create a
    // literal `*` collection and cover nothing (#1010).
    if (collName === PERMISSION_WILDCARD) continue
    if (isSecretBearingReservedCollection(collName) && !granteeMayHoldSecrets) continue
    if (callerKeyring.deks.has(collName)) continue
    if (await collectionHasRecords(store, vault, collName)) continue
    callerKeyring.deks.set(collName, await generateDEK())
    mintedForGrant = true
  }
  // Only when we actually minted: the grantor's own keyring file has to record
  // the new DEK, or their next write to that collection would mint a SECOND,
  // different one and orphan the copy we are about to wrap for the grantee.
  if (mintedForGrant) await persistKeyring(store, vault, callerKeyring)

  // Wrap the appropriate DEKs with the new user's KEK
  const wrappedDeks: Record<string, string> = {}
  for (const collName of Object.keys(permissions)) {
    if (collName === PERMISSION_WILDCARD) continue
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
  // #1010 — `permissions: { '*': ... }` puts a permission-scoped grantee on the
  // same footing as the whole-vault roles: every DEK the grantor holds. Note the
  // inherent limit the caller must know about — this covers the collections that
  // exist NOW. A wildcard cannot enumerate collections created later, and a DEK
  // can only ever be wrapped at grant time, so a later collection needs a
  // re-grant (the read path says so explicitly).
  if (
    options.role === 'owner' ||
    options.role === 'admin' ||
    options.role === 'custodian' ||
    options.role === 'viewer' ||
    permissionsAreWildcard(options.permissions)
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
  const authority = {
    user_id: options.userId,
    display_name: options.displayName,
    role: options.role,
    permissions,
    granted_by: callerKeyring.userId,
    ...(options.exportCapability !== undefined && { export_capability: options.exportCapability }),
    ...(options.importCapability !== undefined && { import_capability: options.importCapability }),
  }
  const keyringFile: KeyringFile = {
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    ...authority,
    deks: wrappedDeks,
    salt: bufferToBase64(newSalt),
    created_at: new Date().toISOString(),
    canary,
    // The grantee's own copy of the roster key rode in via the `_`-prefix
    // propagation loop above, so they can verify this tag on first unlock.
    roster_tag: await mintRosterTag(authority, callerRosterKey),
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
  rosterKey: EnclaveKey,
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
    // #1096 — the two fields this walk steers on, `role` and `granted_by`, are
    // both plaintext. A forged `granted_by` re-parents a descendant admin out
    // of the cascade so a revoke silently leaves them in place; a forged `role`
    // hides them from the walk entirely. Verify every file before reading
    // either — this is the graph the whole cascade is computed from.
    await assertRosterTagValid(kf, rosterKey, userId)
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
    // #1077 — the entry may be absent because a PREVIOUS revoke deleted it and
    // then failed during rotation. `revoke()` deletes first and rotates second,
    // with no transaction, so that window is reachable by any store error.
    //
    // Throwing here is what made the state dangerous: the operator retries,
    // sees "has no keyring", reads it as "already revoked, nothing to do", and
    // stops — while the keys were never rotated. The failure was silent
    // precisely because it looked like success.
    //
    // An uncommitted rotation on the caller's own keyring is the evidence that
    // this happened (`pending_deks`, #1074). Resume it rather than reporting a
    // not-found: finishing the interrupted job is what the operator asked for,
    // and it makes retrying `revoke()` idempotent instead of misleading.
    const pending = [...(callerKeyring.pendingDeks?.keys() ?? [])]
    if (pending.length > 0) {
      await rotateKeys(store, vault, callerKeyring, { collections: pending })
      return
    }
    throw new NoAccessError(`User "${options.userId}" has no keyring in vault "${vault}"`)
  }

  const targetKeyring = targetFound.file

  // #1096 — `canRevoke` below consumes `targetKeyring.role`, and the cascade
  // walk consumes `granted_by` from every keyring in the vault. Both come from
  // the plaintext header, so verify before either is trusted.
  const callerRosterKey = requireRosterKey(callerKeyring, 'revoke')
  await assertRosterTagValid(targetKeyring, callerRosterKey, options.userId)

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
    const descendants = await findAdminDescendants(store, vault, options.userId, callerRosterKey)
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
          // Re-read, so re-verify: the walk above proved a file at one moment,
          // this is a second fetch from the same untrusted store.
          await assertRosterTagValid(descFound.file, callerRosterKey, userId)
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
  //
  // #1043 — this is UNCONDITIONAL, and it is what makes revocation mean
  // anything. Revocation's first act is `store.delete(vault, '_keyring',
  // userId)`, and the store is untrusted by design: it can simply decline.
  // The revoked member's old keyring file is authentic — it unwraps under
  // their own KEK and its canary verifies — so nothing in `loadKeyring` can
  // tell it is stale. Rotation is the only step the store cannot suppress,
  // because it re-keys the records themselves. A probe confirmed both halves:
  // with rotation the revoked member is locked out entirely; without it,
  // revocation is a complete no-op and they keep reading data written after
  // they were revoked.
  // #1096 — the set above is derived from DEK-map keys, so it picks up the
  // reserved roster key, which is not a collection and must never be rotated
  // (see the refusal in `rotateKeys`). Dropped here, at the one site that
  // gathers it implicitly, so `rotateKeys` can stay loud about explicit asks.
  affectedCollections.delete(ROSTER_KEY_ID)
  if (affectedCollections.size > 0) {
    const { unverified } = await rotateKeys(store, vault, callerKeyring, {
      collections: [...affectedCollections],
    })
    // #1114 — `revoke` resolves to void, so without this the quarantine would
    // be the one thing a rotation reports that nobody can hear. Noisy and
    // itemised on purpose, matching the `cascade: 'warn'` warning above: the
    // operator needs the names, because each one is a member who is now locked
    // out of the vault by a file only an out-of-band repair can fix.
    if (unverified.length > 0) {
      console.warn(
        `[noy-db] revoke(${options.userId}): ${unverified.length} member(s) were SKIPPED by the ` +
          `rotation because their keyring failed roster authentication: ` +
          `${unverified.map((u) => `${u.userId} (${u.reason})`).join(', ')}. ` +
          'The revocation itself completed. Those members cannot open the vault and did not ' +
          'receive the rotated keys; their keyring files need repair or removal (noy-db#1114).',
      )
    }
  }
}

// ─── Roster diagnostics + quarantine (#1121) ───────────────────────────

/** What {@link verifyRoster} found. */
export interface RosterVerifyResult {
  /**
   * How many `_keyring` files were examined.
   *
   * Reported first, and deliberately: "nothing unverified" is equally true of a
   * sweep that examined nothing, and a roster check that silently covered zero
   * members would look identical to a healthy vault. Same lesson as the vault
   * head's `no-expectations` verdict (#1101).
   */
  readonly checked: number
  /** The files that failed authentication, and why. */
  readonly unverified: ReadonlyArray<{
    readonly userId: string
    readonly reason: KeyringTamperedReason
  }>
}

/**
 * Verify every `_keyring` file in the vault, without touching any of them.
 *
 * Before this there was no way to learn WHICH file was unverifiable except by
 * trial: a member's own unlock failed, `revoke` of that member failed, and
 * (before #1114) every rotation failed too — all with the same error, none
 * naming the file. Read-only and side-effect free, so it is safe to run when
 * something is already wrong.
 */
/**
 * Read a keyring file for AUDIT rather than for use (#1121).
 *
 * `readKeyringFile` does a bare `JSON.parse`, which is right everywhere it is
 * used to OPEN a keyring — a file that will not parse cannot be honoured, and
 * throwing is the honest outcome. It is wrong for the two tools built to deal
 * with files that are already broken: a truncated `_data` made `verifyRoster`
 * throw instead of reporting, and made the one file most in need of quarantine
 * the one file quarantine could not touch.
 */
async function readKeyringForAudit(
  store: NoydbStore,
  vault: string,
  userId: string,
): Promise<{ file: KeyringFile } | { unparseable: true } | undefined> {
  const envelope = await store.get(vault, '_keyring', userId)
  if (!envelope) return undefined
  try {
    return { file: parseKeyringEnvelope(envelope) }
  } catch {
    return { unparseable: true }
  }
}

export async function verifyRoster(
  store: NoydbStore,
  vault: string,
  callerKeyring: UnlockedKeyring,
): Promise<RosterVerifyResult> {
  const rosterKey = requireRosterKey(callerKeyring, 'verifyRoster')
  const unverified: Array<{ userId: string; reason: KeyringTamperedReason }> = []
  let checked = 0

  for (const userId of await store.list(vault, '_keyring')) {
    const found = await readKeyringForAudit(store, vault, userId)
    if (!found) continue // raced with a delete; not this function's business
    checked += 1
    if ('unparseable' in found) {
      unverified.push({ userId, reason: 'unparseable' })
      continue
    }
    try {
      await assertRosterTagValid(found.file, rosterKey, userId)
    } catch (err) {
      // Only the tamper verdict is a finding. Anything else is a real failure
      // and must not be reported as a roster problem.
      if (!(err instanceof KeyringTamperedError)) throw err
      unverified.push({ userId, reason: err.details.reason })
    }
  }

  return { checked, unverified }
}

/** What {@link quarantineKeyring} did. */
export interface QuarantineResult {
  readonly userId: string
  /** Why the file could not be authenticated — the justification for removing it. */
  readonly reason: KeyringTamperedReason
  /** Collections re-keyed as part of the removal. */
  readonly rotated: readonly string[]
  /**
   * (member, collection) pairs whose access the rotation dropped — the OTHER
   * members, who must be re-granted.
   *
   * Passed through from `rotateKeys` rather than discarded, because a
   * quarantine rotates broadly (see the scope note on the function) and so
   * de-provisions more people than the one being removed. An operator who is
   * not told this discovers it as unrelated `NoAccessError`s later.
   */
  readonly needsRegrant: RotateResult['needsRegrant']
  /**
   * OTHER members whose own files also failed authentication, found while
   * rotating. One forged file is rarely the only one, and the operator is
   * already holding the tool for them.
   */
  readonly alsoUnverified: RotateResult['unverified']
}

/**
 * Remove a `_keyring` file that cannot be authenticated, and re-key behind it
 * (#1121).
 *
 * ## Why this is not a flag on `revoke`
 *
 * `revoke` reads the target's own `role` to decide whether the caller may
 * revoke them, so it cannot act on a file it will not trust — which left a
 * forged file removable only by editing the store by hand. Relaxing `revoke`
 * conditionally would grow the safe path a parameter that turns it into the
 * dangerous one; ADR 0003's standing rule is that if the implementation needs
 * to weaken a guard, the design is wrong. This is a separate operation with its
 * own contract, so `revoke`'s invariant stays absolute and the dangerous act is
 * named at the call site rather than hidden in an option bag.
 *
 * ## The two properties that keep it from being a backdoor
 *
 * 1. **It refuses a file that verifies.** Otherwise it would delete any keyring
 *    while ignoring `canRevoke` — including an owner's, which `revoke` protects
 *    unconditionally.
 * 2. **Because of (1) it can safely ignore the claimed `role` — and it must.**
 *    `canRevoke` refuses any target whose role reads `owner`, so a store that
 *    forged `"role":"owner"` onto its victim would otherwise make them
 *    permanently unremovable. Consulting the forged field is exactly the
 *    mistake this operation exists to avoid.
 *
 * Owner-only: the narrowest role that can always act, and quarantine
 * deliberately consumes NO field of the file it is removing.
 *
 * ## Why it rotates, and why the scope comes from the CALLER
 *
 * Deleting the file is not a revocation — the store may decline the delete, and
 * the member may already hold unwrapped DEKs. So this rotates, exactly as
 * `revoke` does. The scope is every collection the CALLER holds, not the
 * target's DEK map: that map is unauthenticated (#1115), so deriving the scope
 * from it would let the store choose which collections survive a quarantine.
 *
 * ⚠️ **That is the security-correct scope, and it is NOT free.** An earlier
 * draft of this comment called over-rotating "the safe direction"; a review
 * probe disproved it. Rotation re-keys `store.list(vault, <name>)` plus the
 * derived refs `rotateKeys` knows about, so a DEK slot whose ciphertext lives
 * under a *different* collection name — `_blob`, whose data sits in
 * `_blob_index`/`_blob_chunks`, and the `collection#tier` slots — is re-keyed
 * without its data being re-encrypted, and that data then fails to open. That
 * gap belongs to `rotateKeys` (it is reachable through an ordinary `revoke` of
 * a whole-vault grantee, with no quarantine involved) and is filed as #1122,
 * but a quarantine takes the maximal scope *unconditionally*, so it meets the
 * gap every time rather than occasionally. Until that is fixed, treat a
 * quarantine as an emergency operation with a real blast radius, and read
 * `needsRegrant` afterwards.
 */
export async function quarantineKeyring(
  store: NoydbStore,
  vault: string,
  callerKeyring: UnlockedKeyring,
  userId: string,
): Promise<QuarantineResult> {
  if (callerKeyring.role !== 'owner') {
    throw new PermissionDeniedError(
      `Role "${callerKeyring.role}" cannot quarantine a keyring — quarantine is owner-only, ` +
        'because it removes a file whose own authority claims cannot be trusted.',
    )
  }
  if (userId === callerKeyring.userId) {
    throw new ValidationError(
      'quarantineKeyring: refusing to quarantine the calling keyring. Removing your own ' +
        'keyring and rotating behind it would leave the vault with no reachable owner.',
    )
  }

  const rosterKey = requireRosterKey(callerKeyring, 'quarantineKeyring')
  const found = await readKeyringForAudit(store, vault, userId)
  if (!found) {
    // #1077's window, reached the same way: this deletes first and rotates
    // second with no transaction, so a store error in between leaves the file
    // gone and the keys un-rotated. Throwing not-found on the retry is what
    // makes that state dangerous — the operator reads it as "already done" and
    // stops, while the rotation never finished. An uncommitted rotation on the
    // caller's own keyring (`pending_deks`, #1074) is the evidence, so resume
    // it and make the retry idempotent instead of misleading. Same handling as
    // `revoke`; the remedy must not be "call a different function".
    const pending = [...(callerKeyring.pendingDeks?.keys() ?? [])]
    if (pending.length > 0) {
      const resumed = await rotateKeys(store, vault, callerKeyring, { collections: pending })
      return {
        userId,
        reason: 'roster-tag-mismatch',
        rotated: pending,
        needsRegrant: resumed.needsRegrant,
        alsoUnverified: resumed.unverified,
      }
    }
    throw new NoAccessError(`No keyring found for user "${userId}" in vault "${vault}"`)
  }

  let reason: KeyringTamperedReason | null = null
  if ('unparseable' in found) {
    reason = 'unparseable'
  } else {
    try {
      await assertRosterTagValid(found.file, rosterKey, userId)
    } catch (err) {
      if (!(err instanceof KeyringTamperedError)) throw err
      reason = err.details.reason
    }
  }
  if (reason === null) {
    throw new ValidationError(
      `quarantineKeyring: the keyring for "${userId}" authenticates correctly, so it is not a ` +
        'quarantine case — use revoke() instead. Quarantine bypasses the role checks revoke ' +
        'performs, so it is restricted to files that genuinely fail authentication.',
    )
  }

  await store.delete(vault, '_keyring', userId)
  await deleteUserEnvelope(store, vault, userId)
  await deleteUserVisibility(store, vault, userId)

  const rotated = [...callerKeyring.deks.keys()].filter((c) => c !== ROSTER_KEY_ID)
  const result = rotated.length > 0
    ? await rotateKeys(store, vault, callerKeyring, { collections: rotated })
    : { needsRegrant: [], unverified: [] }

  return {
    userId,
    reason,
    rotated,
    needsRegrant: result.needsRegrant,
    alsoUnverified: result.unverified,
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

  // #1096 — verify BEFORE the guards below, not just before the restamp. The
  // role-elevation checks consume `target.role`, so a forged one does not only
  // get laundered into the output — it decides whether this edit is permitted
  // at all. Every field not named in `options` is also carried through the
  // spread, so an unverified read would authenticate forgeries nobody touched.
  const rosterKey = requireRosterKey(callerKeyring, 'updateKeyringIdentity')
  await assertRosterTagValid(target, rosterKey, options.userId)

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

  // This function exists to edit another member's AUTHORITY without holding
  // their credential, which is exactly the power a hostile store was helping
  // itself to. The caller's own roster key (verified against `target` above)
  // is what re-authenticates the result; the target's canary rides the spread
  // untouched.
  const edited: KeyringFile = {
    ...target,
    ...(options.role !== undefined && { role: options.role }),
    ...(options.displayName !== undefined && {
      // null clears the field (stored as ""); a string sets it.
      display_name: options.displayName ?? '',
    }),
    ...(options.permissions !== undefined && { permissions: options.permissions }),
  }
  const next: KeyringFile = { ...edited, roster_tag: await mintRosterTag(edited, rosterKey) }

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
  /**
   * Members skipped because their `_keyring` file failed roster verification
   * (#1114).
   *
   * Rotation hands a member re-wrapped DEKs, so skipping one gives them
   * **less**, never more: the file is left untouched and its wrappings for the
   * rotated collections go stale. That is the same fail-closed end state as
   * `needsRegrant`, but it needs a different remedy and so gets a different
   * field — a `needsRegrant` entry is fixed by `grant()`, whereas one of these
   * is a file that no longer authenticates and cannot be repaired by granting
   * over it.
   *
   * Before this existed, one such file threw and took `revoke` and
   * `rotateKeys` down vault-wide — the two operations most needed when a
   * roster is suspect.
   */
  readonly unverified: ReadonlyArray<{
    readonly userId: string
    readonly reason: KeyringTamperedReason
  }>
}

/** Options for {@link rotateKeys} (#846b — was a bare `string[]`). */
export interface RotateKeysOptions {
  /** Collections whose DEKs are re-minted. */
  readonly collections: readonly string[]
}

/**
 * Collections whose envelopes are sealed under **another** collection's DEK
 * (#1108).
 *
 * ## The defect this closes
 *
 * `rotateKeys` re-keys by collection NAME, which silently assumes DEK-name and
 * collection-name are 1:1. They are not. A history snapshot lives in
 * `_history` but is sealed under its **source** collection's DEK, and
 * `_ledger_deltas` is sealed under the `_ledger` DEK. So a revocation rotated
 * the live records and left their prior versions readable under the key the
 * revoked member walked away with — for a history-enabled collection, that is
 * substantially its whole content.
 *
 * Measured before the fix: a revoked member's retained `docs` DEK opened the
 * live record (no) and `_history/docs:d1:…` (YES).
 *
 * ## Why the layouts are duplicated here rather than imported
 *
 * `with-party` has never imported `with-commit` or `with-shape` and this is not
 * the change that should start — `with-shape/blobs/blob-set.ts` already imports
 * `with-party/team/tiers.js`, so the reverse edge would close a cycle. The id
 * layouts below are copied deliberately, with their owners named, and the
 * **invariant test is what keeps them honest**: after a revocation, no retained
 * key may open any envelope. That test does not consult this table, so a
 * service that adds a further such surface fails there rather than passing
 * quietly here.
 *
 * ## The blob surfaces (#1122)
 *
 * `_blob` was the same defect one layer worse: the slot is `_blob` and every
 * byte it protects is filed under `_blob_index` / `_blob_chunks`, so rotating
 * it re-encrypted NOTHING and made the vault's blobs permanently unreadable —
 * reachable through an ordinary `revoke`, since a whole-vault grantee holds
 * `_blob`. Those two are not in this table because they cannot be re-keyed by
 * the generic per-envelope helper (chunks use a bespoke AAD, and the index body
 * carries wrapped per-blob CEKs); {@link rekeyBlobSet} handles them and
 * `rotateKeys` calls it for the `_blob` slot.
 *
 * What IS in this table is the other half: the three per-collection blob
 * surfaces sealed under the OWNING collection's DEK rather than under `_blob`.
 */
const HISTORY_COLLECTION = '_history' // owner: with-commit/history/history.ts
const LEDGER_COLLECTION = '_ledger' // owner: with-commit/history/ledger/constants.ts
const LEDGER_DELTAS_COLLECTION = '_ledger_deltas' // ditto
const BLOB_COLLECTION = '_blob' // owner: with-shape/blobs/blob-set.ts
const BLOB_SLOTS_PREFIX = '_blob_slots_' // ditto — `_blob_slots_<collection>`
const BLOB_VERSIONS_PREFIX = '_blob_versions_' // ditto — `_blob_versions_<collection>`
const BLOB_INTENT_COLLECTION = '_blob_intent' // owner: with-shape/blobs/blob-intent.ts

/** `store.list` on a collection that may not exist yet. */
async function listOrEmpty(store: NoydbStore, vault: string, collection: string): Promise<string[]> {
  try { return await store.list(vault, collection) } catch { return [] }
}

/**
 * Envelopes sealed under `rotated`'s DEK but stored under a different
 * collection — the refs {@link rotateKeys} must re-key alongside the collection
 * itself.
 */
async function derivedRefsFor(
  store: NoydbStore,
  vault: string,
  rotated: string,
): Promise<Array<{ collection: string; id: string }>> {
  const out: Array<{ collection: string; id: string }> = []

  // `_history` snapshot ids are `${collection}:${recordId}:${paddedVersion}`,
  // and each is sealed under `${collection}`'s DEK. Reserved collections have
  // no history of their own, so only user collections contribute.
  if (!rotated.startsWith('_')) {
    for (const id of await listOrEmpty(store, vault, HISTORY_COLLECTION)) {
      if (id.startsWith(`${rotated}:`)) out.push({ collection: HISTORY_COLLECTION, id })
    }
  }

  // Every `_ledger_deltas` entry is sealed under the `_ledger` DEK.
  if (rotated === LEDGER_COLLECTION) {
    for (const id of await listOrEmpty(store, vault, LEDGER_DELTAS_COLLECTION)) {
      out.push({ collection: LEDGER_DELTAS_COLLECTION, id })
    }
  }

  // #1122 — the per-collection blob surfaces. A slot map and a version record
  // are sealed under the OWNING collection's DEK (`dekKey(collection, tier)`),
  // not under `_blob`, and a `_blob_intent` marker under that collection's
  // tier-0 DEK. All three use the ordinary record AAD, so the generic
  // per-envelope helper re-keys them; only `_blob_index`/`_blob_chunks` need
  // `rekeyBlobSet`. Reserved collections own none of these.
  if (!rotated.startsWith('_')) {
    for (const id of await listOrEmpty(store, vault, `${BLOB_SLOTS_PREFIX}${rotated}`)) {
      out.push({ collection: `${BLOB_SLOTS_PREFIX}${rotated}`, id })
    }
    for (const id of await listOrEmpty(store, vault, `${BLOB_VERSIONS_PREFIX}${rotated}`)) {
      out.push({ collection: `${BLOB_VERSIONS_PREFIX}${rotated}`, id })
    }
    // Marker ids are `${collection}::${recordId}` — the `::` separator is
    // refused in record ids at the blob write surface, so the prefix is
    // unambiguous.
    for (const id of await listOrEmpty(store, vault, BLOB_INTENT_COLLECTION)) {
      if (id.startsWith(`${rotated}::`)) out.push({ collection: BLOB_INTENT_COLLECTION, id })
    }
  }

  return out
}

export async function rotateKeys(
  store: NoydbStore,
  vault: string,
  callerKeyring: UnlockedKeyring,
  opts: RotateKeysOptions,
): Promise<RotateResult> {
  // #1096 — the roster key is NOT rotatable, and this refusal is load-bearing.
  //
  // Rotating it would mint a fresh roster key for the caller and then DROP the
  // entry from every other member's file (rotation cannot re-wrap for a member
  // whose KEK it cannot derive) — so the next `loadKeyring` for every remaining
  // member would throw `roster-key-missing` and the whole vault would be
  // unopenable. It also buys nothing: the roster tag defends against the STORE,
  // which never holds a key, and explicitly not against a member who has
  // already walked away with one.
  //
  // THROWN, not silently dropped. `revoke` — the one caller that could pass it
  // implicitly, since it derives its set from `Object.keys(target.deks)` —
  // filters it out at source instead. So anything arriving here named it, and
  // a caller that asks to rotate the roster key has a mistaken model of what
  // rotation does; swallowing that would hide the mistake rather than fix it.
  const { collections } = opts
  if (collections.includes(ROSTER_KEY_ID)) {
    throw new ValidationError(
      `rotateKeys: "${ROSTER_KEY_ID}" is the vault roster key, not a collection, and cannot be ` +
        'rotated — doing so would strip it from every other member and leave the vault unopenable. ' +
        'Remove it from `collections`.',
    )
  }
  // FR-6: re-keying is an owner-only meta-capability. A custodian operates the
  // vault fully but must NOT rotate — rotation would let it mint fresh DEKs and
  // strip the sealed owner's access, breaking the inalienability floor.
  if (callerKeyring.role === 'custodian') {
    throw new PermissionDeniedError(
      'custodian cannot rotate keys (FR-6: re-key is an owner-only meta-capability; use the Deed owner)',
    )
  }
  const callerRosterKey = requireRosterKey(callerKeyring, 'rotateKeys')
  // Generate new DEKs for each affected collection
  // #1074 part 2 — RESUME. A pending DEK means a previous rotation of this
  // collection was interrupted after persisting its key but before committing.
  // Reuse it: minting a fresh one would strand every record the interrupted run
  // already moved, since nothing would hold the key they were sealed under.
  //
  // This is what makes `rotateKeys` its own resume path — re-running it after a
  // crash finishes the job rather than starting a second, incompatible one.
  const newDeks = new Map<string, EnclaveKey>()
  for (const collName of collections) {
    newDeks.set(collName, callerKeyring.pendingDeks?.get(collName) ?? await generateDEK())
  }

  // Persist the new DEKs BEFORE rewriting a single record. This is the whole
  // fix: previously the key existed only in memory until after the loop, so any
  // interruption left already-rewritten records sealed under a key that was
  // never saved — permanently unreadable, not merely un-migrated.
  //
  // `deks` still holds the OLD key here, so reads during the window continue to
  // work for records the loop has not reached. Records it HAS reached are
  // unreadable until the rotation is resumed — degraded, but recoverable, which
  // is the property that was missing.
  // `pendingDeks` is optional on the public `UnlockedKeyring` — absent simply
  // means no rotation is in flight — so materialise it on first use rather than
  // forcing every constructor of the type to write an empty map.
  const pending = callerKeyring.pendingDeks ?? new Map<string, EnclaveKey>()
  ;(callerKeyring as { pendingDeks?: Map<string, EnclaveKey> }).pendingDeks = pending
  for (const [collName, newDek] of newDeks) {
    pending.set(collName, newDek)
  }
  await persistKeyring(store, vault, callerKeyring)

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
  // #1074 — CRASH-SAFETY HAZARD, still open, and the scope is GENERAL.
  //
  // This was previously filed as D-5 and described narrowly: "in a mixed
  // collection, if a later record throws". That framing understated it and is
  // why it sat. The hazard applies to ANY interruption of this loop — a thrown
  // error, a process kill, a lost connection — because the new DEK exists only
  // in memory until `persistKeyring` runs AFTER every record is rewritten.
  // Interrupt it and the already-rewritten records are sealed under a DEK that
  // was never persisted: permanently unreadable, not merely un-migrated.
  //
  // Fixed separately (see #1074): the new DEK must be persisted BEFORE the loop
  // so a resume can find it. Doing that needs the keyring to hold two
  // generations transiently, so it is its own change rather than part of this
  // one. What IS fixed here is everything the loop does to a record it reaches.
  for (const collName of collections) {
    const oldDek = callerKeyring.deks.get(collName)
    const newDek = newDeks.get(collName)!
    if (!oldDek) continue

    // #1122 — `_blob` protects data filed under NO collection of its own.
    // Its ciphertext lives in `_blob_index` and `_blob_chunks`, in shapes the
    // per-envelope helper below cannot open (a bespoke chunk AAD, and wrapped
    // per-blob CEKs inside the index body), so it gets its own enclave routine.
    // Before this, rotating `_blob` minted a key, re-encrypted nothing, and
    // destroyed every blob in the vault — through an ordinary `revoke`.
    //
    // Tier slots too: an elevated record's blob metadata is sealed under
    // `dekKey('_blob', tier)` — `_blob#<tier>` — and filed in that same
    // `_blob_index`, so membership there is by DEK, not by name. The other keys
    // the caller holds are passed so an entry belonging to a DIFFERENT blob
    // slot is recognised as that slot's business rather than mistaken for a
    // damaged record; an entry no held key opens is genuinely damaged and
    // throws, as `rekeyEnvelopeIfNeeded` does.
    if (collName === BLOB_COLLECTION || collName.startsWith(`${BLOB_COLLECTION}#`)) {
      const others: EnclaveKey[] = []
      for (const [name, dek] of callerKeyring.deks) if (name !== collName) others.push(dek)
      for (const [name, dek] of newDeks) if (name !== collName) others.push(dek)
      await rekeyBlobSet(store, vault, oldDek, newDek, others)
    }

    // The collection's own records, PLUS every envelope sealed under this DEK
    // but filed elsewhere (#1108). Both go through the same helper, so the
    // resume property holds for derived surfaces too: `rekeyEnvelopeIfNeeded`
    // returns null for anything already under `newDek`.
    const refs: Array<{ collection: string; id: string }> = [
      ...(await store.list(vault, collName)).map((id) => ({ collection: collName, id })),
      ...(await derivedRefsFor(store, vault, collName)),
    ]
    for (const ref of refs) {
      const { collection: refColl, id } = ref
      const envelope = await store.get(vault, refColl, id)
      if (!envelope || !envelope._iv) continue

      // #1074 — one enclave helper does the whole per-record rotation:
      // carries every slot except `_bidx`, and re-wraps a per-record CEK
      // instead of trying to decrypt its body under the DEK. Both were wrong
      // inline here, and `enclave-body-only` is why they moved — envelope
      // surgery belongs in the enclave, where the guard can see it.
      // Returns null when this record is already under `newDek` — the
      // resumed-rotation case. A record readable under NEITHER key rethrows
      // rather than being skipped: walking silently past unreadable records
      // would turn a loud failure into permanent quiet loss.
      const newEnvelope = await rekeyEnvelopeIfNeeded({ collection: refColl, id }, envelope, oldDek, newDek)
      if (newEnvelope !== null) await store.put(vault, refColl, id, newEnvelope)
    }
  }

  // COMMIT (#1074 part 2). Every record is now under the new key, so promote
  // it and clear the pending marker. A keyring that still carries `pending_deks`
  // after this point means the rotation did not reach here.
  for (const [collName, newDek] of newDeks) {
    callerKeyring.deks.set(collName, newDek)
    callerKeyring.pendingDeks?.delete(collName)
  }
  await persistKeyring(store, vault, callerKeyring)

  // Drop the rotated collections from every OTHER member's keyring.
  //
  // The old comment here said these were "re-wrapped", which is what
  // `Noydb.rotate`'s jsdoc promised too — but re-wrapping is impossible and
  // always was (#854). See the note below.
  const needsRegrant: Array<{ userId: string; collection: string }> = []
  const unverified: Array<{ userId: string; reason: KeyringTamperedReason }> = []
  const userIds = await store.list(vault, '_keyring')
  for (const userId of userIds) {
    if (userId === callerKeyring.userId) continue

    const userFound = await readKeyringFile(store, vault, userId)
    if (!userFound) continue

    const userKeyringFile = userFound.file
    // #1096 — VERIFY BEFORE RESTAMPING. This loop edits and re-signs a file it
    // read from an untrusted store, so without this it would take a forged
    // roster that `loadKeyring` refuses and hand it back a GENUINE tag. And
    // `revoke` calls this unconditionally, so one forged member plus any later
    // revocation anywhere in the vault would be a complete bypass.
    //
    // #1114 — SKIP the member rather than failing the rotation. Throwing here
    // meant one bad file froze `revoke` and `rotateKeys` for the whole vault,
    // including the revoke that would have removed it. Skipping is safe
    // precisely HERE, and the reason is directional: this loop's effect on a
    // member is to hand them re-wrapped DEKs, so declining to process one gives
    // them LESS. Their file is not restamped (nothing laundered) and not
    // re-wrapped (no new key), leaving the same fail-closed end state rotation
    // already produces for a member it cannot re-wrap for (#854).
    //
    // Only the tamper verdict is caught. Any other failure is still fatal —
    // "skip on error" would quietly convert a bug into a silent no-rotation,
    // which is the shape of defect this subsystem keeps finding.
    try {
      await assertRosterTagValid(userKeyringFile, callerRosterKey, userId)
    } catch (err) {
      if (!(err instanceof KeyringTamperedError)) throw err
      unverified.push({ userId, reason: err.details.reason })
      continue
    }
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

    // #1096 — `permissions` is an authority field, so narrowing it here
    // invalidates the member's existing roster tag. Restamp with the caller's
    // roster key (same key: it is vault-wide).
    const edited: KeyringFile = {
      ...userKeyringFile,
      deks: updatedDeks,
      permissions: updatedPermissions,
    }
    const updatedKeyring: KeyringFile = {
      ...edited,
      roster_tag: await mintRosterTag(edited, callerRosterKey),
    }

    await writeKeyringFile(store, vault, userId, updatedKeyring)
  }

  return { needsRegrant, unverified }
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
  // #1096 — verified before ANY of it is consumed: the echo guard below steers
  // on it, and the carry-forward further down re-signs it.
  if (existingFound) {
    await assertRosterTagValid(existingFound.file, requireRosterKey(keyring, 'changeSecret'), keyring.userId)
  }
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

  // #1096 — the roster key is one of `keyring.deks`, so it was re-wrapped
  // under the new KEK by the loop above and travels with the secret change.
  const rosterKey = requireRosterKey(keyring, 'changeSecret')
  const canary = await mintKeyringCanary(newKek)
  // Carry the ORIGIN + capability fields forward, exactly as `persistKeyring`
  // does. `UnlockedKeyring` carries none of them, so rebuilding the file from
  // it re-parented `granted_by` to the holder themselves — collapsing the admin
  // delegation subtree — and silently dropped a time-boxed grant and both
  // capability bits. #1096 turns each of those from a quiet erasure into an
  // AUTHENTICATED one, since the tag below now signs whatever is left.
  const existingAuthority = existingFound?.file
  const keptGrantedBy = existingAuthority?.granted_by ?? keyring.userId
  const authority = {
    user_id: keyring.userId,
    display_name: keyring.displayName,
    role: keyring.role,
    permissions: keyring.permissions,
    granted_by: keptGrantedBy,
    ...(existingAuthority?.expires_at !== undefined && { expires_at: existingAuthority.expires_at }),
    ...(existingAuthority?.export_capability !== undefined && { export_capability: existingAuthority.export_capability }),
    ...(existingAuthority?.import_capability !== undefined && { import_capability: existingAuthority.import_capability }),
  }
  const keyringFile: KeyringFile = {
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    ...authority,
    deks: wrappedDeks,
    salt: bufferToBase64(newSalt),
    created_at: new Date().toISOString(),
    canary,
    roster_tag: await mintRosterTag(authority, rosterKey),
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
export interface PodRecipient {
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
  recipient: PodRecipient,
): Promise<KeyringFile> {
  if (!callerKeyring.kek) {
    throw new ValidationError(
      'buildRecipientKeyringFile: caller keyring has no KEK — tier-2 wrap-DEKs ' +
        'and tier-3 PIN-resume sessions cannot create bundle recipients. ' +
        'Re-authenticate at tier 1 (secret) before building a bundle.',
    )
  }
  const rosterKey = requireRosterKey(callerKeyring, 'buildRecipientKeyringFile')

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
  const authority = {
    user_id: recipient.id,
    display_name: recipient.displayName ?? recipient.id,
    role,
    permissions,
    granted_by: callerKeyring.userId,
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
  return {
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    ...authority,
    deks: wrappedDeks,
    salt: bufferToBase64(newSalt),
    created_at: new Date().toISOString(),
    canary,
    // The recipient's copy of the roster key rode in via the `_`-prefix
    // propagation loop above, so the slot verifies on first unlock.
    roster_tag: await mintRosterTag(authority, rosterKey),
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
  // #1096 — DELIBERATELY UNVERIFIED. `role` and `permissions` below come
  // straight from the plaintext header, so a hostile store can misreport them
  // in a directory listing. Not verified because this is a display surface with
  // no caller keyring in scope, and every ENFORCEMENT path (loadKeyring, grant,
  // revoke, updateUser, recover, tier-2 unlock) verifies independently. If this
  // output ever feeds an authorisation decision, that stops being true.
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
  // #1096 — DELIBERATELY UNVERIFIED. `role` and `permissions` below come
  // straight from the plaintext header, so a hostile store can misreport them
  // in a directory listing. Not verified because this is a display surface with
  // no caller keyring in scope, and every ENFORCEMENT path (loadKeyring, grant,
  // revoke, updateUser, recover, tier-2 unlock) verifies independently. If this
  // output ever feeds an authorisation decision, that stops being true.
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
/**
 * Does this collection already hold persisted records?
 *
 * The one question that separates "I am creating this collection" from "I was
 * never given the key to this collection" (#1004). Kept deliberately narrow:
 * it asks the store, not the schema registry, because the store is the only
 * authority on what ciphertext actually exists.
 */
async function collectionHasRecords(
  store: NoydbStore,
  vault: string,
  collectionName: string,
): Promise<boolean> {
  const ids = await store.list(vault, collectionName)
  return ids.length > 0
}

/**
 * Re-read this principal's persisted keyring and adopt the DEK for one
 * collection if it has appeared there since this handle unlocked (#1010).
 *
 * Returns the DEK (also caching it into `keyring.deks`) or `null` when the
 * persisted keyring genuinely does not carry it. Only ever called on the
 * miss path, so an up-to-date handle never pays for it.
 *
 * @internal
 */
async function reloadPersistedDEK(
  store: NoydbStore,
  vault: string,
  keyring: UnlockedKeyring,
  collectionName: string,
): Promise<EnclaveKey | null> {
  if (!keyring.kek) return null
  const found = await readKeyringFile(store, vault, keyring.userId)
  const wrapped = found?.file.deks[collectionName]
  if (wrapped === undefined) return null
  try {
    const dek = await unwrapKey(wrapped, keyring.kek)
    keyring.deks.set(collectionName, dek)
    return dek
  } catch {
    // A DEK that will not unwrap under this KEK is corruption, not access —
    // fall through to the caller's denial rather than masking it as success.
    return null
  }
}

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
      // #1004 — minting on a DEK miss is only correct when the caller is
      // ENTITLED to the collection (they are creating it, or they were granted
      // it and it did not exist at grant time). For an unentitled caller the
      // miss IS the denial, and minting fabricated a key that decrypts none of
      // the stored envelopes — so the denial re-emerged from the enclave as an
      // AES-GCM tag failure, i.e. `TamperedError`, the signal reserved for
      // genuine ciphertext corruption. In a zero-knowledge design the DEK is
      // the access control, so an unentitled miss is exactly `NoAccessError`.
      //
      // Entitlement is read straight off the keyring — no store round-trip, so
      // the authorized mint path costs exactly what it did before.
      //
      // System collections (`_ledger`, `_meta`, `_history`, the fanout
      // sidecars …) are exempt: their DEKs are propagated to every role at
      // grant time and they are minted lazily by machinery running on behalf
      // of a user who may hold no explicit permission for them. They are never
      // addressable by user code, so nothing is being protected by denying
      // here — only internal writes would break.
      if (!collectionName.startsWith('_')) {
        if (!hasAccess(keyring, collectionName)) {
          throw new NoAccessError(
            `No access — user does not have a key for collection "${collectionName}". ` +
              'Grant them this collection in `permissions` to give them one.',
          )
        }
        // #1010 — the ENTITLED half of the same defect. Being allowed to read a
        // collection is not the same as holding its key: a grant only ever
        // wraps the DEKs that exist at grant time, and re-wrapping later is
        // impossible because it needs the grantee's KEK, derived from a secret
        // the vault never stores. So a principal granted BEFORE a collection
        // existed is entitled to it and has no key for it — and minting one
        // here produced a key that decrypts nothing, resurfacing as
        // `TamperedError`. This is reachable for every whole-vault role
        // (`admin`, `viewer`, `custodian`) and for a `'*'` wildcard grantee.
        //
        // Costs one `list()`, and only on this path: an entitled principal
        // whose keyring is missing a DEK. Creating a genuinely new collection
        // finds no records and mints exactly as before.
        if (await collectionHasRecords(store, vault, collectionName)) {
          // Before denying: the in-memory keyring may simply be STALE. A DEK is
          // minted lazily by whichever handle first touches a collection and
          // persisted to the keyring file — so a second live handle for the
          // SAME principal (a second tab, a second `createNoydb` over one
          // store) that was opened before the collection existed holds a
          // keyring snapshot without it. That principal is not unauthorized;
          // their own key is already on disk. Re-read it.
          //
          // This is what separates "my snapshot is behind" from "I was granted
          // before this collection existed": only the latter finds nothing.
          const refreshed = await reloadPersistedDEK(store, vault, keyring, collectionName)
          if (refreshed) return refreshed
          throw new NoAccessError(
            `No access — user "${keyring.userId}" is entitled to collection "${collectionName}" ` +
              'but holds no key for it, because the collection was created AFTER their grant. ' +
              'A collection DEK can only be wrapped at grant time (wrapping needs the grantee\'s ' +
              'secret, which the vault never stores), so this cannot be back-filled — re-grant ' +
              'the user to give them the key.',
          )
        }
      }
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

/**
 * The `Permissions` catch-all key (#1010). `Permissions` has always documented
 * `'*'` as "the wildcard collection matching all collections in the vault", but
 * nothing expanded it — a grantee handed the documented catch-all got no keys
 * at all. It is honoured in three places, and they must agree: the DEK wrapping
 * in `grant()`, and both permission checks below.
 */
export const PERMISSION_WILDCARD = '*'

/** Does this permission map hand over the whole vault? */
export function permissionsAreWildcard(permissions: Permissions | undefined): boolean {
  return permissions !== undefined && PERMISSION_WILDCARD in permissions
}

/** Check if a user has write permission for a collection. */
export function hasWritePermission(keyring: UnlockedKeyring, collectionName: string): boolean {
  // FR-6: custodian writes every collection (admin-level operational rw).
  if (keyring.role === 'owner' || keyring.role === 'admin' || keyring.role === 'custodian') return true
  if (keyring.role === 'viewer' || keyring.role === 'client') return false
  if (keyring.permissions[PERMISSION_WILDCARD] === 'rw') return true
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
  if (PERMISSION_WILDCARD in keyring.permissions) return true
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
  const rosterKey = requireRosterKey(keyring, 'persistKeyring')
  // Carry the `echo` block forward (#940). This function rebuilds the file
  // from the `UnlockedKeyring`, which deliberately carries no echo info (same
  // rationale as the `changeSecret` guard), so it has to be read back off the
  // persisted file — otherwise the first DEK-provisioning write would drop it
  // and silently degrade an echo keyring into a standard one that no secret
  // shape can open (the KEK stays echo-derived).
  const existingFound = await readKeyringFile(store, vault, keyring.userId)
  // #1096 — narrower than the read-modify-restamp sites, but the same shape:
  // every field carried forward below comes from a fresh, unverified re-read,
  // and the tag minted at the bottom would authenticate whatever came back.
  // (Absent on a first write, which is not a forgery — nothing to verify.)
  if (existingFound) await assertRosterTagValid(existingFound.file, rosterKey, keyring.userId)
  const existingEcho = existingFound?.file.echo
  // Same carry-forward rationale as `echo`, for two fields that describe the
  // keyring's ORIGIN rather than its current contents. `UnlockedKeyring` does
  // not carry either, so rebuilding the file from it defaulted `granted_by` to
  // the holder themselves and stamped a fresh `created_at` — meaning any
  // DEK-provisioning write silently re-parented the holder to themselves and
  // collapsed the admin delegation subtree that `granted_by` encodes.
  const existingGrantedBy = existingFound?.file.granted_by
  const existingCreatedAt = existingFound?.file.created_at
  // Third field of the same class, and #1096 raised the stakes on it.
  // `UnlockedKeyring` does not carry `expires_at`, so rebuilding the file from
  // it silently CLEARED a bundle slot's expiry on any DEK-provisioning write —
  // turning a time-boxed audit grant into a permanent one. Worse now: the
  // roster tag would be stamped over the cleared value, so the erasure would
  // come out authenticated.
  const existingExpiresAt = existingFound?.file.expires_at

  const wrappedDeks: Record<string, string> = {}
  for (const [collName, dek] of keyring.deks) {
    wrappedDeks[collName] = await wrapKey(dek, keyring.kek)
  }
  // #1074 — an uncommitted rotation's key must survive a crash, so it is
  // persisted under its own field rather than mixed into `deks`, which would
  // make readers treat it as current before any record had moved.
  const wrappedPending: Record<string, string> = {}
  for (const [collName, dek] of keyring.pendingDeks ?? []) {
    wrappedPending[collName] = await wrapKey(dek, keyring.kek)
  }
  const canary = await mintKeyringCanary(keyring.kek)

  // #1096 — build the authority half first and stamp from exactly that
  // object, so the tag covers precisely what is persisted rather than a
  // hand-copied restatement of it.
  const authority = {
    user_id: keyring.userId,
    display_name: keyring.displayName,
    role: keyring.role,
    permissions: keyring.permissions,
    granted_by: existingGrantedBy ?? keyring.userId,
    ...(existingExpiresAt !== undefined && { expires_at: existingExpiresAt }),
    ...(keyring.exportCapability !== undefined && { export_capability: keyring.exportCapability }),
    ...(keyring.importCapability !== undefined && { import_capability: keyring.importCapability }),
  }
  const keyringFile: KeyringFile = {
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    ...authority,
    deks: wrappedDeks,
    ...(Object.keys(wrappedPending).length > 0 ? { pending_deks: wrappedPending } : {}),
    salt: bufferToBase64(keyring.salt),
    created_at: existingCreatedAt ?? new Date().toISOString(),
    canary,
    roster_tag: await mintRosterTag(authority, rosterKey),
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
  const envelope = buildRecordEnvelope(
    { collection: '_keyring', id: userId, version: 1 },
    { iv: '', data: JSON.stringify(keyringFile) },
  )
  await store.put(vault, '_keyring', userId, envelope)
}
