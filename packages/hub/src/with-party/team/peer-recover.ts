/**
 * Atomic peer-recovery primitive.
 *
 * `recoverUser` is a SEPARATE operation from `revoke + grant`. It
 * exists because peer-recovery has different semantics than account
 * removal-then-reissue:
 *
 *   1. **Same identity preserved.** `userId`, `role`, `permissions`,
 *      capability bits, user envelope (if any), policy override (if
 *      any) all survive. Only the wrapping changes.
 *   2. **No key rotation.** The existing DEKs stay valid — every
 *      OTHER principal in the vault keeps their access. Rotating
 *      keys would invalidate every co-user's wrapping.
 *   3. **Atomic by construction.** A single `store.put` overwrites
 *      `_keyring/<userId>` with the recovered file. No revoke step
 *      means no partial-failure window.
 *   4. **Owner→owner natively allowed.** Two co-owners recovering
 *      each other is the explicitly-intentional case (a partner
 *      forgot the master phrase). The existing `canRevoke` rule that
 *      blocks owner→owner is correct for `revoke` (which is account
 *      *removal*) and intentionally NOT replicated here. The policy
 *      gate `peer-recover-user` carries the freshness requirement.
 *   5. **Tier-2 slots dropped.** The slots wrap the OLD KEK under
 *      method-derived keys; after recovery the KEK is re-derived
 *      from the new temp secret. Match `rotateSecret`'s
 *      precedent — the recovered user re-enrols slots after picking
 *      their own phrase.
 *
 * Caller must be at least as privileged as the target. The hub
 * `db.recoverUser` method gates this with the `peer-recover-user`
 * policy gate (the `peer-recover-user` factor-proof requirement); the function below
 * enforces only the role + anti-privilege-escalation invariants.
 *
 * @module
 */
import type { NoydbStore, KeyringFile, Role } from '../../kernel/types.js'
import { NOYDB_KEYRING_VERSION } from '../../kernel/types.js'
import { deriveKey, generateSalt, wrapKey, bufferToBase64 } from '../../kernel/enclave/index.js'
import { NoAccessError, PermissionDeniedError, PrivilegeEscalationError } from '../../kernel/errors.js'
import { assertStrongSecret, type SecretPolicy } from '../../kernel/validation.js'
import type { UnlockedKeyring } from './keyring.js'
import { mintKeyringCanary } from './keyring.js'

// FR-6: 'custodian' is deliberately ABSENT — an admin cannot peer-recover a
// custodian (mirrors ADMIN_GRANTABLE_TARGETS: custodians are owner-managed
// only). The owner CAN recover one (canRecover returns true for owner). As a
// CALLER, a custodian recovers nobody (it is neither owner nor admin → false).
const ADMIN_RECOVERABLE_TARGETS: readonly Role[] = ['operator', 'viewer', 'client', 'admin']

/**
 * Whether `callerRole` may recover `targetRole`.
 *
 * Differs from `canRevoke` (in `keyring.ts`) in one critical place:
 * **owner→owner IS allowed**. Peer recovery is the explicitly
 * intentional case (a co-owner forgot their phrase); the freshness
 * binding lives in the `peer-recover-user` policy gate, not in the
 * permission predicate.
 *
 * Admins can recover everyone they could grant (operator / viewer /
 * client / admin) but NOT owners — that boundary stays as a hard
 * structural rule even under recovery.
 */
function canRecover(callerRole: Role, targetRole: Role): boolean {
  if (callerRole === 'owner') return true
  if (callerRole === 'admin') return ADMIN_RECOVERABLE_TARGETS.includes(targetRole)
  return false
}

/** Input shape for {@link recoverUser}. */
export interface RecoverUserOptions {
  /** Target user id whose keyring is being recovered. */
  readonly userId: string
  /**
   * Temporary secret under which the new keyring is wrapped.
   * The recipient should call `db.rotateSecret` immediately on
   * acceptance to choose their own phrase — this temp acts as a
   * single-use bridge in invite / peer-recovery flows.
   */
  readonly secret: string
  /** Override the target's role. Defaults to the existing target's role. */
  readonly role?: Role
  /** Override the target's display name. Defaults to existing. */
  readonly displayName?: string
  /** Validate phrase strength against the configured policy. */
  readonly validateSecret?: boolean
  /**
   * Skip phrase strength validation even when `validateSecret` is
   * set. The escape hatch matches `grant`'s shape — used when the
   * temp phrase is a high-entropy one-shot string that doesn't need
   * to satisfy the human-typeable rules.
   */
  readonly allowWeakSecret?: boolean
  /**
   * Optional explicit phrase policy override (passed through to
   * `assertStrongSecret`). Mirrors how `grant` accepts a custom
   * `SecretPolicy` for app-specific tightening.
   */
  readonly secretPolicy?: SecretPolicy
}

/**
 * Atomically rewrap the target user's keyring under a fresh temp
 * secret. Single store write; no revoke step; no key rotation.
 *
 * Caller's responsibilities (NOT enforced here):
 *   - Run the `peer-recover-user` policy gate first via
 *     `Noydb.checkGate` to enforce the freshness factor proof.
 *   - Communicate the temp secret to the recipient via a secure
 *     channel (URL fragment, in-person, etc.) — the hub does not
 *     transport secrets.
 */
export async function recoverUser(
  store: NoydbStore,
  vault: string,
  callerKeyring: UnlockedKeyring,
  options: RecoverUserOptions,
): Promise<void> {
  // 1. Load the target's existing keyring file (plaintext header).
  const env = await store.get(vault, '_keyring', options.userId)
  if (!env) {
    throw new NoAccessError(
      `recoverUser: user "${options.userId}" has no keyring in vault "${vault}".`,
    )
  }
  const target = JSON.parse(env._data) as KeyringFile
  const targetRole = options.role ?? target.role

  // 2. Permission check — caller must be allowed to recover this role.
  //    Owner→owner natively allowed; admin→admin allowed; admin→owner blocked.
  if (!canRecover(callerKeyring.role, targetRole)) {
    throw new PermissionDeniedError(
      `Role "${callerKeyring.role}" cannot recover role "${targetRole}"`,
    )
  }
  // Also guard against role-uplift via the override — admin cannot
  // promote a target to owner under cover of recovery.
  if (!canRecover(callerKeyring.role, target.role)) {
    throw new PermissionDeniedError(
      `Role "${callerKeyring.role}" cannot recover role "${target.role}"`,
    )
  }

  // 3. Anti-privilege-escalation. Every collection the target had
  //    access to must be in the caller's DEK set — the recoverer
  //    cannot give the recovered user access to a collection the
  //    recoverer themselves can't read. Mirrors `grant()`'s check.
  for (const coll of Object.keys(target.deks)) {
    if (!callerKeyring.deks.has(coll)) {
      throw new PrivilegeEscalationError(coll)
    }
  }

  // 4. Optional phrase strength validation (mirrors `grant` opt-in).
  if (options.validateSecret && !options.allowWeakSecret) {
    assertStrongSecret(options.secret, options.secretPolicy)
  }

  // 5. Mint a fresh salt + KEK from the temp secret. The DEKs
  //    themselves are unchanged — only the wrapping is replaced.
  const newSalt = generateSalt()
  const newKek = await deriveKey(options.secret, newSalt)

  const wrappedDeks: Record<string, string> = {}
  for (const coll of Object.keys(target.deks)) {
    const callerDek = callerKeyring.deks.get(coll)
    if (!callerDek) {
      // Already caught by the anti-privilege-escalation loop above.
      // This branch is defensive belt-and-braces; if it ever fires,
      // the target had a collection the caller's deks Map disagrees
      // with — fail loud rather than silently dropping access.
      throw new PrivilegeEscalationError(coll)
    }
    wrappedDeks[coll] = await wrapKey(callerDek, newKek)
  }

  // 6. Build the recovered keyring file. Identity preserved; wrapping
  //    refreshed; tier-2 slots dropped (they wrap the OLD KEK and
  //    can't survive a tier-1 phrase change — same precedent as
  //    rotateSecret). Mint a fresh canary under newKek; the
  //    OLD canary on the spread `...target` would fail to verify against
  //    the new KEK and trip KeyringCorruptError on next load.
  const canary = await mintKeyringCanary(newKek)
  const next: KeyringFile = {
    ...target,
    _noydb_keyring: NOYDB_KEYRING_VERSION,
    role: targetRole,
    display_name: options.displayName ?? target.display_name,
    deks: wrappedDeks,
    salt: bufferToBase64(newSalt),
    granted_by: callerKeyring.userId,
    authenticators: [],
    canary,
  }

  // 7. Single atomic write — overwrites the existing envelope.
  //    Backend `put` is the canonical write primitive across every
  //    `to-*` store; no partial-failure window between revoke + grant.
  const envelope = {
    _noydb: 1 as const,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(next),
  }
  await store.put(vault, '_keyring', options.userId, envelope)
}
