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
 * admins edit authority they don't hold the target's credential for), so this
 * stops the store — which holds no keys — and deliberately NOT a malicious
 * member. SECURITY.md states the bound.
 *
 * `user_id` is inside the canonical string so a genuine tag cannot be
 * transplanted onto another member's file.
 */
import type { KeyringFile } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import { encrypt, decrypt } from '../../kernel/enclave/index.js'

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

/** false on decrypt failure OR canonical mismatch — never throws. */
export async function verifyRosterTag(
  file: RosterAuthorityFields,
  tag: RosterTag | undefined,
  rosterKey: EnclaveKey,
): Promise<boolean> {
  if (tag === undefined) return false
  try {
    return (await decrypt(tag.iv, tag.data, rosterKey)) === rosterCanonical(file)
  } catch {
    return false
  }
}
