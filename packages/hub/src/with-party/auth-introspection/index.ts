/**
 * Authentication introspection.
 *
 * Three surfaces over the configured tier model and the actual
 * per-user enrollment state:
 *
 * 1. **Vault-wide English summary** — {@link describeAuthConfig}.
 * 2. **Vault-wide Mermaid diagram** — {@link diagramAuthConfig}.
 * 3. **Per-user introspection** — {@link describeUserAuth}, gated by
 *    the `view-user-auth` policy gate (off by default).
 *
 * The per-user surface is held to a strict allowlist — fields not on
 * the allowlist are dropped, never rendered. The negative test in
 * `auth-introspection.test.ts` exercises the allowlist by feeding a
 * contrived keyring with fake "secret" fields and asserting that none
 * of them appear in the output.
 *
 * @module
 */
import type { NoydbStore, KeyringFile, KeyringAuthenticator } from '../../kernel/types.js'
import type { VaultPolicy, GatePolicy } from '../../kernel/policy/types.js'
import { loadVaultPolicy } from '../../kernel/policy/storage.js'
import { loadPaperRecoveryEntries } from '../team/recovery.js'

/** Vault-wide English summary of the configured authentication graph. */
export async function describeAuthConfig(
  store: NoydbStore,
  vault: string,
): Promise<string> {
  const policy = (await loadVaultPolicy(store, vault)) ?? defaultPolicySnapshot()
  const recoveryProfiles = await listRecoveryProfilesEnrolled(store, vault)

  const lines: string[] = []
  lines.push(`Vault "${vault}" — three-tier authentication`)
  lines.push('')
  lines.push('Tier 1 — Passphrase (master)')
  lines.push(`  Phrase format: ${policy.passphrase?.minWords ?? 6}+ words, lowercase letters, ≥${policy.passphrase?.minWordLength ?? 3} chars/word`)
  lines.push('  Strength validator: enforced (override available for tests only)')
  lines.push('')
  lines.push('Tier 2 — Authenticate (routine login)')
  lines.push('  Allowed methods: WebAuthn (passkey), OIDC, Password')
  lines.push('  Slots per user: unlimited')
  lines.push('')
  lines.push('Tier 3 — Unlock (quick resume)')
  lines.push('  Method: PIN (per-app configurable)')
  lines.push('')
  lines.push(`Recovery profiles enrolled: ${recoveryProfiles.length === 0 ? 'none' : recoveryProfiles.join(', ')}`)
  lines.push('Managed-passphrase mode: off (post-1.0)')
  lines.push('')
  lines.push('Sensitive-action gates:')
  for (const [gate, gp] of Object.entries(policy.gates) as Array<[string, GatePolicy]>) {
    lines.push(`  ${gate} — ${describeGatePolicy(gp)}`)
  }
  return lines.join('\n')
}

/**
 * Render the vault's auth graph as Mermaid `flowchart TB` source. The
 * caller pipes this through Mermaid (CLI or browser) to get an SVG.
 */
export async function diagramAuthConfig(
  store: NoydbStore,
  vault: string,
): Promise<string> {
  const policy = (await loadVaultPolicy(store, vault)) ?? defaultPolicySnapshot()
  const lines: string[] = []
  lines.push('flowchart TB')
  lines.push(`  vault["Vault: ${escapeMermaid(vault)}"]`)
  lines.push('  tier1["Tier 1<br/>Passphrase"]')
  lines.push('  tier2["Tier 2<br/>Multi-slot Authenticate"]')
  lines.push('  tier3["Tier 3<br/>PIN / Quick-resume"]')
  lines.push('  vault --> tier1')
  lines.push('  tier1 --> tier2')
  lines.push('  tier2 --> tier3')
  for (const [gateName, gp] of Object.entries(policy.gates) as Array<[string, GatePolicy]>) {
    if (gp.enabled === false) continue
    const id = sanitizeId(gateName)
    const label = `${gateName}<br/>tier ≥ ${gp.minTier}`
    lines.push(`  ${id}["${escapeMermaid(label)}"]`)
    const tierNode = gp.minTier === 1 ? 'tier1' : gp.minTier === 2 ? 'tier2' : 'tier3'
    lines.push(`  ${tierNode} --> ${id}`)
  }
  return lines.join('\n')
}

/**
 * Render the per-user enrollment summary. Returns an empty
 * (non-throwing) string when the user has no keyring file — never
 * confirms or denies the existence of the user from the document
 * alone.
 *
 * Sanitization is strict: only the slot list, enrollment dates, and
 * recovery-profile counts are rendered. WebAuthn cred ids, OIDC
 * subject ids, password hashes, recovery codes, TOTP secrets — all
 * dropped at the allowlist boundary, not redacted.
 */
export async function describeUserAuth(
  store: NoydbStore,
  vault: string,
  userId: string,
): Promise<string> {
  const env = await store.get(vault, '_keyring', userId)
  if (!env) return ''
  const file = JSON.parse(env._data) as KeyringFile

  const lines: string[] = []
  lines.push(
    `User: ${file.user_id} (joined ${file.created_at.slice(0, 10)}, role: ${file.role})`,
  )
  lines.push('')
  lines.push('Tier 2 enrollments:')
  if (!file.authenticators || file.authenticators.length === 0) {
    lines.push('  (none enrolled)')
  } else {
    for (const slot of file.authenticators) {
      lines.push(`  - ${describeSlot(slot)}`)
    }
  }
  return lines.join('\n')
}

/** Bulk variant for owner dashboards. */
export async function describeAllUsersAuth(
  store: NoydbStore,
  vault: string,
): Promise<Array<{ userId: string; description: string }>> {
  const ids = await store.list(vault, '_keyring')
  const results: Array<{ userId: string; description: string }> = []
  for (const userId of ids) {
    const description = await describeUserAuth(store, vault, userId)
    if (description !== '') results.push({ userId, description })
  }
  return results
}

// ─── Helpers ───────────────────────────────────────────────────────────

const SLOT_FIELD_ALLOWLIST: ReadonlyArray<keyof KeyringAuthenticator> = [
  'id',
  'method',
  'enrolled_at',
  'enrolled_via_tier',
] as const

function describeSlot(slot: KeyringAuthenticator): string {
  // Project to the allowlist FIRST — never read meta/wrapped_kek into
  // any user-facing string. The allowlist is the only path values
  // take to the renderer; off-allowlist fields are dropped, not redacted.
  const sanitized: Partial<KeyringAuthenticator> = {}
  for (const key of SLOT_FIELD_ALLOWLIST) {
    if (key in slot) {
      // @ts-expect-error narrow assignment from allowlist iteration
      sanitized[key] = slot[key]
    }
  }
  const date = (sanitized.enrolled_at ?? '').slice(0, 10)
  return `${sanitized.method ?? '?'} (id=${sanitized.id ?? '?'}, enrolled ${date}, via tier ${sanitized.enrolled_via_tier ?? '?'})`
}

function describeGatePolicy(gp: GatePolicy): string {
  if (gp.enabled === false) return 'disabled'
  const parts: string[] = []
  parts.push(`tier ${gp.minTier}`)
  if (gp.factors && gp.factors.length > 0) {
    for (const f of gp.factors) {
      parts.push(`+ ${f.count ?? 1}× ${f.anyOf.join('|')}`)
    }
  }
  if (gp.warn?.sharedDevice === 'block') parts.push('block-on-shared-device')
  return parts.join(' ')
}

function defaultPolicySnapshot(): VaultPolicy {
  return {
    passphrase: { minWords: 6, minWordLength: 3, rejectRepeatedAdjacent: true },
    gates: {},
  }
}

async function listRecoveryProfilesEnrolled(
  store: NoydbStore,
  vault: string,
): Promise<ReadonlyArray<string>> {
  const enrolled: string[] = []
  const paper = await loadPaperRecoveryEntries(store, vault)
  if (paper.length > 0) enrolled.push(`paper (${paper.length} codes)`)
  return enrolled
}

function escapeMermaid(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, ' ')
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '_')
}
