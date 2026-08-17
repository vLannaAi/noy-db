/**
 * #1096 — the authenticated half of a `_keyring` file's AUTHORITY.
 *
 * A `_keyring` file is stored plaintext (`_iv: ''`) so admins can edit a
 * member's authority without holding that member's credential. That means
 * `role`/`permissions` were authenticated by NOTHING — a hostile store could
 * promote a viewer to admin by editing one word (proven in
 * `__tests__/keyring-replay-escalation.test.ts`).
 *
 * The fix is a vault-wide ROSTER KEY, carried as a reserved DEK-map entry
 * (`deks['_roster']`, see `ROSTER_KEY_ID`) so it reaches every member through
 * the channels a DEK already travels — grant's `_`-prefix propagation,
 * `persistKeyring`, the wrapped-DEKs recovery blob, `peer-recover`, pod
 * recipient slots — and a `roster_tag`: AES-GCM of the canonical authority
 * fields under that key. Every roster EDITOR holds the key (constraint:
 * admins edit authority they don't hold the target's credential for) — which
 * is what sets the bound below.
 *
 * `user_id` is inside the canonical string so a genuine tag cannot be
 * transplanted onto another member's file.
 *
 * ## What "authority half" does NOT cover
 *
 * The canonical string is exactly {@link RosterAuthorityFields} — the fields a
 * privilege decision reads. Other plaintext fields are deliberately excluded
 * and REMAIN FORGEABLE by the store: `display_name` (cosmetic), `policy`
 * (round-tripped, never enforced at v1.0), `echo` and `authenticators` (each
 * authenticated by its own wrapped key material — a forged one fails to
 * unlock rather than granting anything), plus `created_at` / `salt` /
 * `_noydb_keyring`. Adding a field to the tag means adding it to
 * `rosterCanonical`; nothing else here is a claim about it.
 *
 * ## The bound
 *
 * This stops the STORE, which holds no keys. It deliberately does NOT stop a
 * malicious MEMBER: every roster editor must hold the roster key, so anyone
 * who legitimately holds it can forge any authority field for any member.
 * That bound must be stated in `SECURITY.md` (tracked as part of the #1096
 * PR) — it is not written there yet.
 */
import type { KeyringFile } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import { encrypt, decrypt } from '../../kernel/enclave/index.js'
import { ROSTER_KEY_ID } from '../../kernel/constants.js'
import { KeyringTamperedError } from '../../kernel/errors.js'

export interface RosterTag { readonly iv: string; readonly data: string }

export type RosterAuthorityFields = Pick<KeyringFile,
  'user_id' | 'role' | 'permissions' | 'granted_by' | 'expires_at' | 'export_capability' | 'import_capability'>

/** Stable stringify — sorts object keys recursively so key order never splits the tag. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function rosterCanonical(file: RosterAuthorityFields): string {
  return stable({
    user_id: file.user_id,
    role: file.role,
    permissions: file.permissions,
    granted_by: file.granted_by,
    expires_at: file.expires_at ?? null,
    export_capability: file.export_capability ?? null,
    import_capability: file.import_capability ?? null,
  })
}

export async function mintRosterTag(file: RosterAuthorityFields, rosterKey: EnclaveKey): Promise<RosterTag> {
  return encrypt(rosterCanonical(file), rosterKey)
}

/**
 * false on decrypt failure OR canonical mismatch — never throws.
 *
 * `null` is accepted alongside `undefined` because the tag arrives from
 * JSON a store controls: `"roster_tag": null` is a shape the type system
 * says is impossible and the wire permits.
 */
export async function verifyRosterTag(
  file: RosterAuthorityFields,
  tag: RosterTag | undefined | null,
  rosterKey: EnclaveKey,
): Promise<boolean> {
  if (tag == null) return false
  try {
    return (await decrypt(tag.iv, tag.data, rosterKey)) === rosterCanonical(file)
  } catch {
    return false
  }
}

/**
 * #1096 — THE CHOKEPOINT. Verify a keyring file's plaintext AUTHORITY half
 * against the roster key carried in its own, already-unwrapped, DEK set.
 * Throws {@link KeyringTamperedError}; returns silently when the roster is
 * authentic.
 *
 * **Every path that builds an `UnlockedKeyring` from a `KeyringFile` must call
 * this — not just `loadKeyring`.** A tier-2 unlock that reconstructs
 * `role`/`permissions` from the plaintext header without it accepts exactly
 * the forgery tier-1 refuses, and the vault is only as strong as its weakest
 * unlock path. That is not hypothetical: the wrap-DEKs password path shipped
 * in this state until it was caught in review.
 *
 * Deliberately says nothing about the canary. The canary proves the KEK, and
 * tier-2 paths have no KEK to prove — the roster key they hold comes from the
 * slot's own wrapped-DEK blob, which is authenticated by its own AES-GCM tag.
 * Callers that DO hold a KEK check the canary separately, before this.
 *
 * @param deks the caller's UNWRAPPED DEK set — a roster key here is proof of
 *   possession, so this must never be handed a map built from unverified input.
 */
export async function assertRosterAuthenticated(
  file: KeyringFile,
  deks: ReadonlyMap<string, EnclaveKey>,
  userId: string,
): Promise<void> {
  const rosterKey = deks.get(ROSTER_KEY_ID)
  if (rosterKey === undefined) {
    // Absence is an alarm, not a skip: deleting a wrapped DEK needs no key, so
    // "verify only when a key is present" would let a store opt out entirely.
    throw new KeyringTamperedError({ userId, reason: 'roster-key-missing' })
  }
  await assertRosterTagValid(file, rosterKey, userId)
}

/**
 * #1096 — VERIFY BEFORE YOU TRUST, and especially before you RESTAMP.
 *
 * The sibling of {@link assertRosterAuthenticated} for the other half of the
 * problem. That one guards paths that *unlock* a keyring; this one guards paths
 * that **read another member's file** — because the roster key is vault-wide, a
 * caller holding it can verify any member's tag, not just their own.
 *
 * Every read-modify-write on a member's roster must call this **before** the
 * modify. A flow that reads a forged file, edits one field and restamps does
 * not merely tolerate the forgery — it **launders** it, converting a file
 * `loadKeyring` refuses into one it accepts, under a genuine tag. `revoke`
 * calls into such a flow unconditionally, so without this a single forged
 * member plus any later revocation anywhere in the vault is a complete bypass.
 *
 * Fail-closed, deliberately: a forged member's file aborts the operation rather
 * than being skipped. Skipping would complete the revoke while leaving the
 * forgery in place, and an untrusted store can already refuse writes — so the
 * availability it costs was never guaranteed, while the integrity it buys is
 * the point of the mechanism.
 */
export async function assertRosterTagValid(
  file: KeyringFile,
  rosterKey: EnclaveKey,
  userId: string,
): Promise<void> {
  if (!(await verifyRosterTag(file, file.roster_tag, rosterKey))) {
    throw new KeyringTamperedError({
      userId,
      reason: file.roster_tag == null ? 'roster-tag-missing' : 'roster-tag-mismatch',
    })
  }
}
