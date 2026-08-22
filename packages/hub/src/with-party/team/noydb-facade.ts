/**
 * Noydb-side auth / recovery / enrollment facade.
 *
 * Holds the tier-2 authenticator enrollment/unlock wrappers, WebAuthn
 * enrollment, auth-config introspection, the tier-1 secret
 * rotate/recover flows, the paper/Shamir recovery rotate/enroll flows,
 * managed-secret recovery, peer-recovery, tier-3 PIN unlock, and the
 * public `getKeyring` accessor.
 *
 * The near-parallel rotate/recover variants (managed vs user vs paper vs
 * Shamir) are deliberately NOT consolidated. The
 * keyring/active-tier/quick-unlock/policy caches stay `Noydb`-resident
 * (shared by the kernel's unlock path) and arrive **by reference** through
 * {@link TeamFacadeDeps}; the keyring-unlock path (`getKeyringInternal`),
 * the policy gate (`checkGate`), the managed-recovery enrolment check
 * (`assertRecoveryEnrolled`), `openVault`, and the one-shot
 * managed-recovery skip flag stay kernel-resident and arrive as callbacks.
 *
 * Internal service — reached through `noydb.team.rotateSecret(...)` etc.
 */
import type { NoydbOptions, NoydbStore, KeyringAuthenticator } from '../../kernel/types.js'
import type { RotateResult, RotateKeysOptions, RosterVerifyResult, QuarantineResult } from './keyring.js'
import { ValidationError } from '../../kernel/errors.js'
import {
  rotateSecret as keyringRotateSecret,
  recoverSecret as keyringRecoverSecret,
  type RotateSecretInput,
  type RecoverSecretInput,
  type RecoverSecretResult,
  type RotateRecoveryOptions,
  type RotateRecoveryResult,
  type EnrollRecoveryResult,
  type RecoveryEnrollmentInput,
  type RecoveryProof,
} from './rotate-recover.js'
import {
  recoverUser as keyringRecoverUser,
  type RecoverUserOptions,
} from './peer-recover.js'
import {
  loadPaperRecoveryEntries,
  savePaperRecoveryEntries,
  mintPaperRecoveryEntry,
  type PaperRecoveryEntry,
  loadShamirRecoveryEntries,
  saveShamirRecoveryEntries,
  mintShamirRecoveryEntry,
  type ShamirRecoveryEntry,
} from './recovery.js'
import { saveSealedSecret } from './managed-secret.js'
import type { NoydbShamir } from './noydb-shamir.js'
import { generateULID } from '../../with-pod/ulid.js'
import { RecoveryProfileNotImplementedError, PolicyDeniedError } from '../../kernel/errors.js'
import {
  describeAuthConfig as fnDescribeAuthConfig,
  diagramAuthConfig as fnDiagramAuthConfig,
  describeUserAuth as fnDescribeUserAuth,
  describeAllUsersAuth as fnDescribeAllUsersAuth,
} from '../auth-introspection/index.js'
import type { Vault } from '../../kernel/vault.js'
import type { UnlockedKeyring } from './keyring.js'
import {
  enrollAuthenticator as keyringEnrollAuthenticator,
  removeAuthenticator as keyringRemoveAuthenticator,
  updateAuthenticator as keyringUpdateAuthenticator,
  findAuthenticator,
  type EnrollAuthenticatorOptions,
  type UpdateAuthenticatorOptions,
} from './authenticators.js'
import type { QuickUnlockStore, QuickUnlockState } from '../session/unlock-state.js'
import type { SecretPolicy } from '../../kernel/validation.js'
import type {
  ActiveTier,
  FactorProofBundle,
  GateName,
  GrantOptions,
  ReAuthOperation,
  RevokeOptions,
  VaultPolicy,
} from '../../kernel/types.js'

/** NoydbOptions with the store resolved to a non-optional value (internal use only). */
type ResolvedNoydbOptions = NoydbOptions & { readonly store: NoydbStore }

/** Everything the moving auth/recovery/enrollment methods touched on the Noydb instance's `this.*`. */
export interface TeamFacadeDeps {
  /** Resolved Noydb options (store, user, secretMode, sealingKey, shamirRecovery, …). */
  readonly options: ResolvedNoydbOptions
  /** Live unlocked-keyring cache (Noydb-resident; read/written by reference). */
  readonly keyringCache: Map<string, UnlockedKeyring>
  /** Per-vault active session tier (Noydb-resident; read/written by reference). */
  readonly activeTier: Map<string, ActiveTier>
  /** Per-vault tier-3 quick-unlock state (Noydb-resident; read/written by reference). */
  readonly quickUnlock: QuickUnlockStore
  /** Per-vault loaded policy cache (Noydb-resident; read/written by reference). */
  readonly policyCache: Map<string, VaultPolicy>
  /** Evaluate the policy gate for an operation (kernel-resident). */
  checkGate(vault: string, gate: GateName, factors?: FactorProofBundle): Promise<void>
  /** Legacy `requireReAuthFor` session-policy check (kernel-resident). */
  checkPolicyOperation(vault: string, op: ReAuthOperation): void
  /** Live-reference keyring unlock path (kernel-resident). */
  getKeyringInternal(
    vault: string,
    opts?: { create: boolean },
  ): Promise<UnlockedKeyring>
  /** Managed-recovery enrolment check (kernel-resident). */
  assertRecoveryEnrolled(
    vault: string,
    policy: VaultPolicy,
    opts?: { skipManagedCheck?: boolean },
  ): Promise<void>
  /** Open (or create) a vault (kernel-resident). */
  openVault(vault: string, opts?: { locale?: string }): Promise<Vault>
  /** Toggle the one-shot managed-mode strong-recovery bypass flag (kernel-resident). */
  setSkipNextManagedRecoveryCheck(value: boolean): void
}

export class TeamFacade {
  constructor(private readonly deps: TeamFacadeDeps) {}

  private requireShamirProvider(): NoydbShamir {
    const p = this.deps.options.shamirRecovery
    if (!p) {
      throw new Error(
        "shamir recovery requires a NoydbShamir — pass "
        + "shamirRecovery: shamirRecoveryProvider() from '@noy-db/on-shamir' to createNoydb()",
      )
    }
    return p
  }

  // ─── Multi-user grant / revoke / rotate runners (#267 team split) ──
  //
  // The kernel's `db.grant` / `db.revoke` / `db.rotate` route through the
  // TeamStrategy seam, which calls back here with the keyring ENGINE as an
  // argument (statically linked in `active.ts`, i.e. only in the
  // `@noy-db/hub/team` subpath bundle). These runners own the policy-gate +
  // keyring plumbing so the kernel keeps single-line delegators and the
  // engines stay off the single-user floor.

  /** Gate + run a `grant` engine. See `Noydb.grant` for the public contract. */
  async runGrant(
    engine: (adapter: NoydbStore, vault: string, callerKeyring: UnlockedKeyring, options: GrantOptions) => Promise<void>,
    vault: string,
    options: GrantOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    this.deps.checkPolicyOperation(vault, 'grant')
    await this.deps.checkGate(vault, 'enroll-user', factors)
    const keyring = await this.deps.getKeyringInternal(vault)
    await engine(this.deps.options.store, vault, keyring, options)
  }

  /** Gate + run a `revoke` engine. See `Noydb.revoke` for the public contract. */
  async runRevoke(
    engine: (adapter: NoydbStore, vault: string, callerKeyring: UnlockedKeyring, options: RevokeOptions) => Promise<void>,
    vault: string,
    options: RevokeOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    this.deps.checkPolicyOperation(vault, 'revoke')
    await this.deps.checkGate(vault, 'revoke-user', factors)
    const keyring = await this.deps.getKeyringInternal(vault)
    await engine(this.deps.options.store, vault, keyring, options)
  }

  /** Gate + run a `rotateKeys` engine. See `Noydb.rotate` for the public contract. */
  async runRotate(
    engine: (store: NoydbStore, vault: string, callerKeyring: UnlockedKeyring, opts: RotateKeysOptions) => Promise<RotateResult>,
    vault: string,
    collections: string[],
  ): Promise<RotateResult> {
    this.deps.checkPolicyOperation(vault, 'rotate')
    const keyring = await this.deps.getKeyringInternal(vault)
    const result = await engine(this.deps.options.store, vault, keyring, { collections })
    // Refresh the cached keyring so subsequent operations see the
    // freshly-rotated DEKs. Without this, `ensureCollectionDEK` on
    // the next Collection access would still hold the old ones.
    this.deps.keyringCache.set(vault, keyring)
    return result
  }

  /** Gate + run the `verifyRoster` engine (#1121). See `Noydb.verifyRoster`. */
  async runVerifyRoster(
    engine: (store: NoydbStore, vault: string, callerKeyring: UnlockedKeyring) => Promise<RosterVerifyResult>,
    vault: string,
  ): Promise<RosterVerifyResult> {
    // Read-only, so it is gated as a read rather than as a roster mutation:
    // this is the call an operator makes when something is ALREADY wrong, and
    // gating it behind the same policy as `revoke` would withhold the
    // diagnostic exactly when it is needed.
    const keyring = await this.deps.getKeyringInternal(vault)
    return engine(this.deps.options.store, vault, keyring)
  }

  /** Gate + run the `quarantineKeyring` engine (#1121). See `Noydb.quarantineKeyring`. */
  async runQuarantine(
    engine: (store: NoydbStore, vault: string, callerKeyring: UnlockedKeyring, userId: string) => Promise<QuarantineResult>,
    vault: string,
    userId: string,
    factors?: FactorProofBundle,
  ): Promise<QuarantineResult> {
    // Gated as `revoke`, and that means BOTH halves. An earlier draft called
    // only `checkPolicyOperation` and claimed parity in this very comment — so
    // a host that demanded a second factor to revoke a member would not have
    // demanded one to delete that member's keyring and re-key the vault, which
    // is strictly the larger act.
    this.deps.checkPolicyOperation(vault, 'revoke')
    await this.deps.checkGate(vault, 'revoke-user', factors)
    const keyring = await this.deps.getKeyringInternal(vault)
    const result = await engine(this.deps.options.store, vault, keyring, userId)
    // Same reason as runRotate: the caller's DEKs were re-minted in place.
    this.deps.keyringCache.set(vault, keyring)
    return result
  }

  // ─── Tier-2 enroll / remove ─────────────────────────────────────
  /**
   * Add a tier-2 authenticator slot to the calling user's keyring.
   * Each slot independently wraps the SAME KEK under a method-specific
   * key — adding a slot is a constant-time keyring write.
   *
   * The wrapping ciphertext is produced by the corresponding
   * `@noy-db/on-*` package (e.g. `enrollPasswordAuthenticator` from
   * `@noy-db/on-password`); the hub persists the result.
   *
   * Gated by `enroll-authenticator`; `presented` carries any factor
   * proofs the active policy demands.
   */
  async enrollAuthenticator(
    vault: string,
    options: EnrollAuthenticatorOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    await this.deps.checkGate(vault, 'enroll-authenticator', factors)
    const keyring = await this.deps.getKeyringInternal(vault)
    const next = await keyringEnrollAuthenticator(this.deps.options.store, vault, keyring, options)
    this.deps.keyringCache.set(vault, next)
  }

  /**
   * Remove a tier-2 authenticator slot. Idempotent — removing a
   * non-existent slot is a successful no-op. Gated by
   * `remove-authenticator`.
   */
  async removeAuthenticator(
    vault: string,
    slotId: string,
    factors?: FactorProofBundle,
  ): Promise<void> {
    await this.deps.checkGate(vault, 'remove-authenticator', factors)
    const keyring = await this.deps.getKeyringInternal(vault)
    const next = await keyringRemoveAuthenticator(this.deps.options.store, vault, keyring, slotId)
    this.deps.keyringCache.set(vault, next)
  }

  /** Read the slot list for a vault. Internal — `describeAuthConfig` consumes this. */
  async listAuthenticators(vault: string): Promise<ReadonlyArray<KeyringAuthenticator>> {
    const keyring = await this.deps.getKeyringInternal(vault)
    return keyring.authenticators
  }

  /**
   * Mutate the `meta` blob on an existing authenticator slot — slot
   * rename, label change, attachment of UI hints. The slot's `id`,
   * `method`, and wrap material (`wrapped_kek` / `wrapped_deks` + `iv`)
   * are immutable through this method. Anti-slot-swap is structural,
   * not gate-driven.
   *
   * `meta` patch semantics (top-level merge):
   *   - Top-level merge — absent keys preserved
   *   - `null` value — delete that meta key
   *   - Other values — replace verbatim
   *
   * Use case: per-slot nickname for "iPhone Touch ID" vs "MacBook
   * Touch ID" disambiguation in admin UIs. The slot id (auto-derived
   * from credentialId prefix) is not human-friendly; `meta.nickname`
   * is.
   *
   * Gated by `update-authenticator`. PERSONAL_POLICY: tier-1 unlock
   * alone (matches enroll/remove). STRICT_POLICY: tier-1 +
   * TOTP/email-OTP factor proof — a malicious rename on a shared
   * workstation could mislead the user about which device a slot
   * corresponds to, so STRICT requires fresh factor binding.
   *
   * @throws `NoAccessError` when no slot with the given id exists.
   * @throws `ValidationError` when no patch field is provided.
   */
  async updateAuthenticator(
    vault: string,
    slotId: string,
    options: UpdateAuthenticatorOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    await this.deps.checkGate(vault, 'update-authenticator', factors)
    const keyring = await this.deps.getKeyringInternal(vault)
    const next = await keyringUpdateAuthenticator(this.deps.options.store, vault, keyring, slotId, options)
    this.deps.keyringCache.set(vault, next)
  }

  /**
   * Native WebAuthn enrollment using the **real** internal keyring.
   *
   * Why this exists: when a consumer is using `createNoydb({ secret })`,
   * they cannot reach the live `UnlockedKeyring` to feed it to
   * `enrollWebAuthn(keyring, vault, opts)` from `@noy-db/on-webauthn`.
   * Constructing a synthetic keyring (the previous workaround) produces
   * a slot whose `wrapped_kek` references the synthetic payload, not
   * the live session — so `unlockViaAuthenticator()` later replaces the
   * live DEK map with stale wrapped DEKs and every decrypt fails.
   *
   * This method runs `ceremony` with the REAL keyring (still in
   * `keyringCache`). The ceremony performs the WebAuthn enrollment and
   * returns the slot options that hub then persists via the standard
   * tier-2 enrollAuthenticator path.
   *
   * Layering note: hub does not import `@noy-db/on-webauthn` (that
   * would invert the dep graph). The consumer wires it in:
   *
   * ```ts
   * import { enrollWebAuthn } from '@noy-db/on-webauthn'
   *
   * await db.team.enrollWebAuthn('demo', async (keyring) => {
   *   const e = await enrollWebAuthn(keyring, 'demo', { rp: {...} })
   *   return {
   *     id: `webauthn-${e.credentialId.slice(0, 8)}`,
   *     method: 'webauthn',
   *     wrapped_kek: e.wrappedPayload,
   *     meta: {
   *       credentialId: e.credentialId,
   *       wrapIv: e.wrapIv,
   *       prfUsed: e.prfUsed,
   *       beFlag: e.beFlag,
   *       requireSingleDevice: e.requireSingleDevice,
   *     },
   *   }
   * })
   * ```
   *
   * Returns the WebAuthn `credentialId` (extracted from `meta.credentialId`)
   * for the caller's lookup index (a bootstrap vault, a Cover,
   * a server-side allowlist).
   *
   * Gated by `enroll-authenticator` like `enrollAuthenticator()` itself.
   */
  async enrollWebAuthn(
    vault: string,
    ceremony: (keyring: UnlockedKeyring) => Promise<EnrollAuthenticatorOptions>,
    factors?: FactorProofBundle,
  ): Promise<{ credentialId: string }> {
    await this.deps.checkGate(vault, 'enroll-authenticator', factors)
    const keyring = await this.deps.getKeyringInternal(vault)
    const slotOptions = await ceremony(keyring)
    if (slotOptions.method !== 'webauthn') {
      throw new ValidationError(
        `enrollWebAuthn: ceremony returned method "${slotOptions.method}"; expected "webauthn". ` +
          'Use db.team.enrollAuthenticator() for non-webauthn methods.',
      )
    }
    const credentialId = (slotOptions.meta as { credentialId?: unknown }).credentialId
    if (typeof credentialId !== 'string' || credentialId.length === 0) {
      throw new ValidationError(
        'enrollWebAuthn: ceremony result must include `meta.credentialId` (base64 string). ' +
          'See @noy-db/on-webauthn enrollWebAuthn() return shape.',
      )
    }
    const next = await keyringEnrollAuthenticator(this.deps.options.store, vault, keyring, slotOptions)
    this.deps.keyringCache.set(vault, next)
    return { credentialId }
  }

  /**
   * Filter the slot list to webauthn-method slots only. Useful for
   * "you have N WebAuthn credentials enrolled" UI surfaces and for
   * deciding when a new device prompt should appear. Identity is
   * `id` + `enrolled_at`; the `meta.credentialId` (base64) is used by
   * `allowCredentials` at unlock time.
   */
  async listWebAuthnSlots(vault: string): Promise<ReadonlyArray<{
    id: string
    enrolledAt: string
    credentialId: string
  }>> {
    const keyring = await this.deps.getKeyringInternal(vault)
    return keyring.authenticators
      .filter((a) => a.method === 'webauthn')
      .map((a) => {
        const credentialId = (a.meta as { credentialId?: unknown }).credentialId
        return {
          id: a.id,
          enrolledAt: a.enrolled_at,
          credentialId: typeof credentialId === 'string' ? credentialId : '',
        }
      })
  }

  /**
   * Resolve a slot by id, then hand the wrapped-KEK ciphertext + meta
   * to the caller-supplied verifier. The verifier is the
   * `unlockWith*` function from the corresponding `@noy-db/on-*`
   * package, e.g. `unlockWithPassword(slot, password)`.
   *
   * On success, mark the active session tier as 2 — subsequent
   * `checkGate` calls see a tier-2 unlock.
   */
  async unlockViaAuthenticator(
    vault: string,
    slotId: string,
    verify: (slot: KeyringAuthenticator) => Promise<UnlockedKeyring>,
  ): Promise<UnlockedKeyring> {
    const keyring = await this.deps.getKeyringInternal(vault)
    const slot = findAuthenticator(keyring, slotId)
    if (!slot) {
      throw new ValidationError(
        `unlockViaAuthenticator: no slot with id "${slotId}" in vault "${vault}".`,
      )
    }
    const unlocked = await verify(slot)
    this.deps.keyringCache.set(vault, unlocked)
    this.deps.activeTier.set(vault, 2)
    return unlocked
  }

  // ─── Auth introspection ─────────────────────────────────────────
  /** English summary of the configured auth model. */
  async describeAuthConfig(vault: string): Promise<string> {
    return fnDescribeAuthConfig(this.deps.options.store, vault)
  }

  /** Mermaid `flowchart TB` source for the auth graph. */
  async diagramAuthConfig(vault: string): Promise<string> {
    return fnDiagramAuthConfig(this.deps.options.store, vault)
  }

  /**
   * Per-user enrollment summary. Gated by `view-user-auth` (default:
   * disabled). Sanitization is allowlist-based — never renders cred
   * ids, password hashes, secrets, or any field outside the allowlist.
   */
  async describeUserAuth(
    vault: string,
    userId: string,
    factors?: FactorProofBundle,
  ): Promise<string> {
    await this.deps.checkGate(vault, 'view-user-auth', factors)
    return fnDescribeUserAuth(this.deps.options.store, vault, userId)
  }

  /** Bulk variant for owner dashboards. Gated by `view-user-auth`. */
  async describeAllUsersAuth(
    vault: string,
    factors?: FactorProofBundle,
  ): Promise<Array<{ userId: string; description: string }>> {
    await this.deps.checkGate(vault, 'view-user-auth', factors)
    return fnDescribeAllUsersAuth(this.deps.options.store, vault)
  }

  // ─── Tier-1 change flows ────────────────────────────────────────
  /**
   * Rotate the user's secret (user remembers old). Validates the
   * new phrase against the configured `secret` policy, runs the
   * `rotate-secret` gate, then re-derives + re-wraps every DEK.
   *
   * Tier-2 authenticator slots are dropped — each slot wraps the old
   * KEK and would need its derivation key to be re-presented. Re-enrol
   * via `db.enrollAuthenticator` after rotation.
   *
   * @throws `WeakSecretError` on a weak new phrase.
   * @throws `PolicyDeniedError` when the gate denies (missing factor, …).
   * @throws `InvalidKeyError` when `oldSecret` is wrong.
   */
  async rotateSecret(
    vault: string,
    input: RotateSecretInput,
    factors?: FactorProofBundle,
  ): Promise<void> {
    // Managed-secret mode: the user does NOT know the
    // current secret (hub generated it and sealed it under the
    // provider). Manual rotation via this method is impossible by
    // construction — surface a clear error rather than fail mid-way
    // with InvalidKeyError once `oldSecret` doesn't match the
    // hub-generated one. Recovery-under-managed (which mints a fresh
    // sealed secret via the provider) is the supported path; it
    // lands in a follow-up.
    if (this.deps.options.secretMode === 'managed') {
      throw new PolicyDeniedError(
        'rotate-secret',
        'disabled',
        { minTier: 1, enabled: false },
        'Managed-secret mode (#14): the secret is hub-generated '
        + 'and sealed under the NoydbSealer — there is no '
        + 'plaintext to rotate. Use the recovery flow (follow-up issue) '
        + 'to mint a fresh sealed secret.',
      )
    }
    await this.deps.checkGate(vault, 'rotate-secret', factors)
    const userId = this.deps.options.user
    const next = await keyringRotateSecret(this.deps.options.store, vault, userId, input)
    this.deps.keyringCache.set(vault, next)
  }

  /**
   * Reset the secret using a recovery proof (user forgot the old).
   * Currently supports the `'paper'` profile end-to-end; the
   * other profiles throw {@link RecoveryProfileNotImplementedError}.
   *
   * Burns the used recovery entry on success.
   */
  async recoverSecret(
    vault: string,
    input: RecoverSecretInput,
    factors?: FactorProofBundle,
  ): Promise<RecoverSecretResult> {
    await this.deps.checkGate(vault, 'recover-secret', factors)
    const userId = this.deps.options.user

    // Snapshot the entries BEFORE recovery — the team function burns
    // exactly one entry, so post-recovery `_meta/recovery-paper`
    // contains `entriesBeforeRecovery.length - 1` entries (the ones
    // the user did NOT just consume). Those are what we replace
    // under the auto-rotation logic.
    const entriesBeforeRecovery = await loadPaperRecoveryEntries(this.deps.options.store, vault)

    const next = await keyringRecoverSecret(this.deps.options.shamirRecovery, this.deps.options.store, vault, userId, input)
    this.deps.keyringCache.set(vault, next)

    const rotateRemaining = input.rotateRemainingCodes ?? true
    const remainingAfterBurn = Math.max(0, entriesBeforeRecovery.length - 1)
    if (!rotateRemaining || remainingAfterBurn === 0) {
      return { newCodes: [] }
    }

    // Auto-rotate: replace the remaining entries with a fresh set
    // minted under the new keyring's DEKs. Wraps the same DEK set the
    // recovered keyring just got, so the new codes round-trip through
    // a future `db.recoverSecret` cleanly.
    //
    // If this step fails (store error mid-mint), we leave the existing
    // post-burn entries in place — the user falls back to the
    // fall back to prior behavior (remaining N-1 codes still valid). Strictly
    // safer than wiping then failing.
    const codeGen = input.codeGenerator ?? generateULID
    const newCodeCount = input.newCodeCount ?? remainingAfterBurn
    const codes: string[] = []
    const newEntries: PaperRecoveryEntry[] = []
    for (let i = 0; i < newCodeCount; i++) {
      const rawCode = codeGen()
      const entry = await mintPaperRecoveryEntry(next.deks, rawCode, generateULID())
      codes.push(rawCode)
      newEntries.push(entry)
    }
    // Single replace-all write — `savePaperRecoveryEntries` overwrites
    // `_meta/recovery-paper` atomically (one envelope `put`).
    await savePaperRecoveryEntries(this.deps.options.store, vault, newEntries)

    return { newCodes: codes }
  }

  /**
   * Deliberate paper-recovery-code regeneration. User knows their
   * secret but wants a fresh sheet — they lost the printout or
   * suspect compromise of the off-site copy.
   *
   * Symmetric to {@link rotateSecret} for the recovery profile:
   * gated, audit-trackable, ergonomic. Replaces (not appends) the
   * paper sheet under `_meta/recovery-paper` in a single envelope `put`.
   *
   * Gated by the `rotate-recovery` policy gate:
   *   - PERSONAL_POLICY: `{ minTier: 1 }` — knowing the secret
   *     suffices, matching the lower-level flow's bar.
   *   - STRICT_POLICY: `{ minTier: 1, factors: [{ anyOf: ['totp',
   *     'email-otp', 'webauthn-roaming'] }] }` — rotation is an
   *     off-site-trust event; require an off-device factor so a
   *     stolen unlocked laptop cannot silently mint a sheet for the
   *     attacker.
   *
   * Defaults `count` to the existing sheet size so consumers aren't
   * surprised by a different code count. Explicit `count` overrides.
   *
   * @throws {@link RecoveryProfileNotImplementedError} when `profile`
   *         is anything other than `'paper'` (v1 dispatch limit).
   * @throws {@link PolicyDeniedError} when the gate denies (missing
   *         factor, tier mismatch, ...).
   * @throws on missing paper sheet — "nothing to rotate" surfaces as
   *         an error rather than silently minting an entire new sheet.
   *
   * @example Default count + show-once UI
   * ```ts
   * const { newCodes } = await db.team.rotateRecovery('acme', { profile: 'paper' })
   * showCodesToUser(newCodes)
   * ```
   *
   * @example STRICT-policy site with TOTP factor proof
   * ```ts
   * await db.team.rotateRecovery(
   *   'acme',
   *   { profile: 'paper', count: 10 },
   *   { factors: [{ kind: 'totp', proof: '123456' }] },
   * )
   * ```
   */
  async rotateRecovery(
    vault: string,
    options: RotateRecoveryOptions,
    factors?: FactorProofBundle,
  ): Promise<RotateRecoveryResult> {
    if (options.profile === 'paper') {
      return this.rotateRecoveryPaper(vault, options, factors)
    }
    if (options.profile === 'shamir') {
      return this.rotateRecoveryShamir(vault, options, factors)
    }
    // Defense-in-depth for `as unknown as ...` bypass.
    throw new RecoveryProfileNotImplementedError(
      (options as { profile: string }).profile,
      '#196',
    )
  }

  private async rotateRecoveryPaper(
    vault: string,
    options: Extract<RotateRecoveryOptions, { profile: 'paper' }>,
    factors?: FactorProofBundle,
  ): Promise<RotateRecoveryResult> {
    await this.deps.checkGate(vault, 'rotate-recovery', factors)

    const existing = await loadPaperRecoveryEntries(this.deps.options.store, vault)
    if (existing.length === 0) {
      throw new Error(
        `db.rotateRecovery: no recovery codes are enrolled for vault "${vault}". ` +
        `Call db.team.enrollRecovery({ profile: 'paper', entries }) first; ` +
        `rotateRecovery replaces an existing sheet rather than minting one from scratch.`,
      )
    }

    const keyring = await this.getKeyring(vault)
    const codeGen = options.codeGenerator ?? generateULID
    const count = options.count ?? existing.length

    const codes: string[] = []
    const newEntries: PaperRecoveryEntry[] = []
    for (let i = 0; i < count; i++) {
      const rawCode = codeGen()
      const entry = await mintPaperRecoveryEntry(keyring.deks, rawCode, generateULID())
      codes.push(rawCode)
      newEntries.push(entry)
    }
    // Atomic replace — `savePaperRecoveryEntries` overwrites
    // `_meta/recovery-paper` in a single envelope `put`.
    await savePaperRecoveryEntries(this.deps.options.store, vault, newEntries)

    return { newCodes: codes, entryId: 'paper-batch' }
  }

  private async rotateRecoveryShamir(
    vault: string,
    options: Extract<RotateRecoveryOptions, { profile: 'shamir' }>,
    factors?: FactorProofBundle,
  ): Promise<RotateRecoveryResult> {
    await this.deps.checkGate(vault, 'rotate-recovery', factors)

    const existing = await loadShamirRecoveryEntries(this.deps.options.store, vault)
    if (existing.length === 0) {
      throw new Error(
        `db.rotateRecovery: no Shamir recovery entry is enrolled for vault "${vault}". ` +
        `Call db.team.enrollRecovery({ profile: 'shamir', k, n }) first; ` +
        `rotateRecovery replaces an existing entry rather than minting one from scratch.`,
      )
    }

    // Pick which entry to rotate.
    let targetEntryId: string
    if (options.entryId !== undefined) {
      const found = existing.find(e => e.entryId === options.entryId)
      if (!found) {
        throw new Error(
          `db.rotateRecovery: no Shamir entry with entryId="${options.entryId}" found `
          + `in vault "${vault}". Available: ${existing.map(e => `"${e.entryId}"`).join(', ')}.`,
        )
      }
      targetEntryId = options.entryId
    } else {
      if (existing.length > 1) {
        throw new Error(
          `db.rotateRecovery: vault "${vault}" has ${existing.length} Shamir entries `
          + `enrolled (${existing.map(e => `"${e.entryId}"`).join(', ')}). `
          + `Pass \`entryId\` to disambiguate which one to rotate; ambiguous rotation `
          + `would risk replacing the wrong entry.`,
        )
      }
      targetEntryId = existing[0]!.entryId
    }

    const keyring = await this.getKeyring(vault)
    const { entry, shareStrings } = await mintShamirRecoveryEntry(
      this.requireShamirProvider(),
      keyring.deks,
      targetEntryId,
      options.k,
      options.n,
      options.label,
    )

    // Atomic single-doc replace: drop the old entry, insert the new one.
    const next: ShamirRecoveryEntry[] = existing
      .filter(e => e.entryId !== targetEntryId)
      .concat(entry)
    await saveShamirRecoveryEntries(this.deps.options.store, vault, next)

    return { newShares: shareStrings, entryId: targetEntryId }
  }

  /**
   * **Atomic create-and-enroll for managed-mode vaults.**
   *
   * Bootstraps a managed-mode vault and enrolls strong recovery in
   * a single ceremony. Under `secretMode: 'managed'`, every
   * `openVault` call requires a strong recovery profile (Shamir
   * today) to be enrolled — otherwise it throws
   * {@link ManagedRecoveryNotEnrolledError}. This method bypasses
   * the check temporarily so the keyring can be created, enrolls
   * the supplied recovery profile(s), then returns the vault.
   *
   * For Shamir enrollments, the show-once share strings come back
   * in `recoveryEnrollments[i].shares`. The hub never retains them
   * — the caller MUST display them to the user (once) before any
   * subsequent operation.
   *
   * Paper alone is NOT a strong profile under managed mode; passing
   * `{ profile: 'paper', ... }` without an accompanying shamir entry
   * is rejected at validation time.
   *
   * ```ts
   * const db = await createNoydb({
   *   store, user: 'alice',
   *   secretMode: 'managed',
   *   sealingKey: macosKeychainSealingProvider({ ... }),
   * })
   *
   * const { vault, recoveryEnrollments } = await db.team.openVaultAndEnrollRecovery('acme', {
   *   recovery: [{ profile: 'shamir', k: 2, n: 3 }],
   * })
   * for (const r of recoveryEnrollments) {
   *   if (r.shares) showSharesToUser(r.shares)  // ONCE
   * }
   * ```
   *
   * @throws ValidationError if recovery is empty, or contains no
   *   strong profile under managed mode.
   */
  async openVaultAndEnrollRecovery(
    vault: string,
    opts: {
      readonly recovery: ReadonlyArray<RecoveryEnrollmentInput>
      readonly locale?: string
    },
  ): Promise<{
    readonly vault: Vault
    readonly recoveryEnrollments: ReadonlyArray<EnrollRecoveryResult>
  }> {
    if (opts.recovery.length === 0) {
      throw new ValidationError(
        'openVaultAndEnrollRecovery: at least one recovery enrollment is required.',
      )
    }

    // Validate "at least one strong" when managed mode is on.
    if (this.deps.options.secretMode === 'managed') {
      const hasStrong = opts.recovery.some(r => r.profile === 'shamir')
      if (!hasStrong) {
        throw new ValidationError(
          'openVaultAndEnrollRecovery: managed-mode vaults require at least one strong '
          + 'recovery profile in the `recovery` array. Paper alone is not strong under '
          + 'managed mode (no user secret to fall back on). Include '
          + '{ profile: "shamir", k, n } in `recovery`.',
        )
      }
    }

    // Temporarily bypass the managed-mode strong-recovery check so
    // openVault can create the keyring. Recovery enrollment happens
    // inside this window; the check is restored at the end.
    this.deps.setSkipNextManagedRecoveryCheck(true)
    let vaultHandle: Vault
    try {
      vaultHandle = await this.deps.openVault(vault, opts.locale !== undefined ? { locale: opts.locale } : undefined)
    } finally {
      this.deps.setSkipNextManagedRecoveryCheck(false)
    }

    // Enroll each recovery profile.
    const recoveryEnrollments: EnrollRecoveryResult[] = []
    for (const enrollment of opts.recovery) {
      recoveryEnrollments.push(await this.enrollRecovery(vault, enrollment))
    }

    // Belt-and-braces final check — by now, strong recovery must be on disk.
    if (this.deps.options.secretMode === 'managed') {
      const policy = this.deps.policyCache.get(vault)
      if (policy) {
        await this.deps.assertRecoveryEnrolled(vault, policy)
      }
    }

    return { vault: vaultHandle, recoveryEnrollments }
  }

  /**
   * **Recovery flow under managed-secret mode.**
   *
   * Replaces the sealed secret of a managed-mode vault with a
   * fresh 256-bit random, sealed under the configured
   * `NoydbSealer`. The user never sees the new secret.
   *
   * Internally:
   *   1. Verify the recovery proof (Shamir today) and unwrap the
   *      DEK set.
   *   2. Mint a fresh 256-bit random as the new effective secret.
   *   3. Rewrap the DEK set under a fresh KEK derived from the new
   *      secret (via the existing `recoverSecret` path).
   *   4. Seal the random bytes under the provider and overwrite
   *      `_meta/sealed-secret`.
   *   5. Drop the keyring cache so the next operation re-derives.
   *
   * The vault's strong-recovery enrollment is preserved across
   * recovery (Shamir entries are not burned on use).
   *
   * @throws ValidationError if the Noydb instance is not in managed mode.
   */
  async recoverManagedSecret(
    vault: string,
    options: {
      readonly recoveryProof: RecoveryProof
      readonly secretPolicy?: SecretPolicy
    },
  ): Promise<void> {
    if (this.deps.options.secretMode !== 'managed') {
      throw new ValidationError(
        'recoverManagedSecret: this method only applies to vaults opened '
        + 'in managed-secret mode. For standard mode, use db.recoverSecret.',
      )
    }
    const provider = this.deps.options.sealingKey
    if (!provider) {
      throw new ValidationError(
        'recoverManagedSecret: createNoydb({ secretMode: "managed" }) requires '
        + '`sealingKey` to be supplied; without it the new sealed secret cannot '
        + 'be persisted.',
      )
    }

    // Mint fresh 256-bit random; base64 it for use as the new
    // effective secret. AES-GCM auth-tag failures in the
    // managed-mode envelope catch tampering.
    const randomBytes = new Uint8Array(32)
    globalThis.crypto.getRandomValues(randomBytes)
    let binary = ''
    for (let i = 0; i < randomBytes.length; i++) binary += String.fromCharCode(randomBytes[i]!)
    const newSecret = btoa(binary)

    try {
      // Seal first; if the provider fails (KMS down, keychain locked),
      // we don't touch the keyring. Then run recoverSecret which
      // rewraps DEKs under the new KEK derived from the random bytes.
      const sealed = await provider.seal(randomBytes)
      await keyringRecoverSecret(
        this.deps.options.shamirRecovery,
        this.deps.options.store,
        vault,
        this.deps.options.user,
        {
          newSecret,
          recoveryProof: options.recoveryProof,
          // The new secret IS 256 bits of random; policy gates on
          // length/entropy don't apply.
          allowWeakSecret: true,
          ...(options.secretPolicy !== undefined
            ? { secretPolicy: options.secretPolicy }
            : {}),
        },
      )
      // Update _meta/sealed-secret with the freshly sealed random.
      // The previous envelope is overwritten by saveSealedSecret.
      await saveSealedSecret(this.deps.options.store, vault, {
        providerId: provider.id,
        sealed,
      })
    } finally {
      // Best-effort zero of the in-memory random buffer.
      randomBytes.fill(0)
    }

    // Drop the keyring cache so the next openVault re-derives from
    // the new sealed envelope.
    this.deps.keyringCache.delete(vault)
  }

  /**
   * Atomic peer-recovery — re-wraps an EXISTING user's keyring under
   * a fresh temp secret in a single store write. Closes the
   * partial-failure window (the previous compose-from-primitives
   * pattern was `db.revoke + db.grant`, two writes — if the issuer
   * cancelled between them the target was locked out entirely).
   *
   * Different from `db.revoke + db.grant`:
   *
   *   - Same `userId`, role, permissions, capabilities preserved.
   *   - DEKs unchanged → every other principal in the vault keeps
   *     access. No key rotation.
   *   - Allows owner→owner natively. The existing
   *     `db.revoke` retains its block — peer-recovery is a separate,
   *     intentionally-named operation.
   *   - Tier-2 slots dropped (they wrap the old KEK).
   *
   * Gated by `peer-recover-user`; `STRICT_POLICY` requires a
   * recovery / TOTP / email-OTP factor proof at the moment of
   * recovery, so the issuer affirmatively re-asserts identity.
   *
   * The recipient should call `db.rotateSecret` on first session
   * to choose their own phrase — the temp acts as a single-use
   * bridge.
   *
   * ```ts
   * await db.team.recoverUser('acme', {
   *   userId: 'bob',
   *   secret: 'temporary-correct-horse-battery-staple-printer',
   * }, { factors: [{ kind: 'recovery' }] })
   * // Bob opens createNoydb({ user: 'bob', secret: tempPhrase })
   * // and immediately calls db.rotateSecret to set his own.
   * ```
   *
   * @throws `NoAccessError` when no keyring exists for the target.
   * @throws `PermissionDeniedError` when the caller's role can't
   *         recover the target's role (admin→owner is blocked even
   *         under recovery).
   * @throws `PrivilegeEscalationError` when the caller lacks a DEK
   *         the target previously had access to.
   *
   */
  async recoverUser(
    vault: string,
    options: RecoverUserOptions,
    factors?: FactorProofBundle,
  ): Promise<void> {
    await this.deps.checkGate(vault, 'peer-recover-user', factors)
    const callerKeyring = await this.deps.getKeyringInternal(vault)
    await keyringRecoverUser(this.deps.options.store, vault, callerKeyring, options)
    // If the caller is recovering THEIR OWN keyring (rare but
    // possible — e.g. a self-recovery flow that bypasses the password
    // ceremony), the keyringCache entry is now stale. Drop it so the
    // next access reloads with the fresh wrapping.
    if (options.userId === this.deps.options.user) {
      this.deps.keyringCache.delete(vault)
    }
  }

  /**
   * Persist a recovery enrollment. Accepts the `'paper'`
   * profile.
   *
   * The hub wraps the user's DEK set (not the KEK) under a code-derived
   * AES-GCM key — see `team/recovery.ts` for the rationale. The mint
   * helper {@link mintPaperRecoveryEntry} is the canonical primitive;
   * pair it with `db.team.getKeyring(vault)` to obtain the live DEK set:
   *
   * ```ts
   * import { mintPaperRecoveryEntry } from '@noy-db/hub'
   *
   * const keyring = await db.team.getKeyring('acme')
   * const codes: string[] = ['CORRECT-HORSE-1', 'BATTERY-STAPLE-2', ...]
   * const entries = await Promise.all(
   *   codes.map((code, i) => mintPaperRecoveryEntry(keyring.deks, code, `code-${i}`)),
   * )
   * await db.team.enrollRecovery('acme', { profile: 'paper', entries })
   * showCodesToUser(codes)
   * ```
   *
   * `@noy-db/on-recovery`'s `generateRecoveryCodeSet`
   * delegates to `mintPaperRecoveryEntry` internally — its output is
   * fed directly to this API. Pick whichever fits your code-gen layer:
   *
   * ```ts
   * import { generateRecoveryCodeSet } from '@noy-db/on-recovery'
   * const { codes, entries } = await generateRecoveryCodeSet({ deks: keyring.deks, count: 8 })
   * await db.team.enrollRecovery('acme', { profile: 'paper', entries })
   * ```
   */
  async enrollRecovery(
    vault: string,
    enrollment: RecoveryEnrollmentInput,
  ): Promise<EnrollRecoveryResult> {
    if (enrollment.profile === 'paper') {
      const existing = await loadPaperRecoveryEntries(this.deps.options.store, vault)
      await savePaperRecoveryEntries(this.deps.options.store, vault, [
        ...existing,
        ...enrollment.entries,
      ])
      // Paper enrollments don't have a single entryId — callers
      // pre-mint with their own ids. Return a stable sentinel so the
      // result type is consistent for both profiles.
      return { entryId: 'paper-batch' }
    }
    if (enrollment.profile === 'shamir') {
      const keyring = await this.getKeyring(vault)
      const entryId = enrollment.entryId ?? generateULID()
      const { entry, shareStrings } = await mintShamirRecoveryEntry(
        this.requireShamirProvider(),
        keyring.deks,
        entryId,
        enrollment.k,
        enrollment.n,
        enrollment.label,
      )
      const existing = await loadShamirRecoveryEntries(this.deps.options.store, vault)
      // If a Shamir entry with this id already exists, replace it
      // (allows callers to be idempotent on `entryId`); otherwise append.
      const next: ShamirRecoveryEntry[] = existing.filter(e => e.entryId !== entryId).concat(entry)
      await saveShamirRecoveryEntries(this.deps.options.store, vault, next)
      return { entryId, shares: shareStrings }
    }
    // Defense-in-depth for `as unknown as ...` bypass at the call site.
    throw new RecoveryProfileNotImplementedError(
      (enrollment as { profile: string }).profile,
      '#196',
    )
  }

  /** Read the persisted recovery entries (paper + Shamir). Used by `describeAuthConfig`. */
  async listRecoveryEntries(
    vault: string,
  ): Promise<{
    paper: ReadonlyArray<PaperRecoveryEntry>
    shamir: ReadonlyArray<ShamirRecoveryEntry>
  }> {
    const paper = await loadPaperRecoveryEntries(this.deps.options.store, vault)
    const shamir = await loadShamirRecoveryEntries(this.deps.options.store, vault)
    return { paper, shamir }
  }

  // ─── Tier-3 enroll / unlock ─────────────────────────────────────
  /**
   * Register a tier-3 quick-unlock state for the vault. The state is
   * an opaque blob produced by `@noy-db/on-pin/enrollPin` (or any
   * compatible primitive). It is held in memory only — never persisted
   * — and auto-clears when its `expiresAt` elapses.
   *
   * Gated by `rotate-unlock` (the same gate covers "set" and "rotate"
   * because tier-3 is a single-slot rolling secret).
   */
  async enrollUnlock(
    vault: string,
    state: QuickUnlockState,
    factors?: FactorProofBundle,
  ): Promise<void> {
    await this.deps.checkGate(vault, 'rotate-unlock', factors)
    this.deps.quickUnlock.set(vault, state)
  }

  /**
   * Resume a session via the registered tier-3 state. The verifier is
   * `@noy-db/on-pin/resumePin` (or compatible). On success, mark the
   * active session tier as 3 — every operation must re-authenticate at
   * tier 2 to elevate.
   *
   * Returns `undefined` (caller should fall back to tier 2) when no
   * tier-3 state is registered.
   */
  async unlockViaPin(
    vault: string,
    resume: (state: QuickUnlockState) => Promise<UnlockedKeyring>,
  ): Promise<UnlockedKeyring | undefined> {
    const state = this.deps.quickUnlock.get(vault)
    if (!state) return undefined
    const keyring = await resume(state)
    this.deps.keyringCache.set(vault, keyring)
    this.deps.activeTier.set(vault, 3)
    return keyring
  }

  /** Drop the tier-3 state for a vault — explicit logout. */
  clearQuickUnlock(vault: string): void {
    this.deps.quickUnlock.delete(vault)
  }

  /**
   * Public accessor for the unlocked keyring of a vault.
   *
   * Returns a **defensive shallow copy** so consumers can read the DEK
   * map and authenticator list without the risk of mutating the hub's
   * internal cache. Internal hub code paths use a live reference
   * via `getKeyringInternal`; ceremonies and external consumers always
   * get a snapshot.
   *
   * The CryptoKey values inside `deks` are not cloned — Web Crypto
   * keys are opaque handles, and a shared handle is intentional
   * (encrypt / decrypt go through the same key the cache holds).
   * Only the container Map / authenticator array is fresh.
   *
   * Used by `@noy-db/on-*` ceremonies that need the live DEK set
   * (paper recovery via {@link mintPaperRecoveryEntry}, tier-3 PIN
   * enrolment via on-pin's `enrollPin`, custom on-* ceremonies that
   * don't have a hub-side wrapper).
   *
   * No new permission gate — this is an accessor over already-unlocked
   * state. The keyring is materialized only after the calling session
   * has unlocked the vault at tier 1, 2, or 3, so exposing it does not
   * widen access. Throws `ValidationError` when encryption is enabled
   * and no `secret` / `getKeyring` is configured.
   *
   * ```ts
   * const keyring = await db.team.getKeyring('acme')
   * // keyring.deks: Map<collection, CryptoKey>
   * // keyring.kek:  CryptoKey | null   (null for tier-3 / wrap-DEKs sessions)
   * // keyring.role / .permissions / .authenticators
   * ```
   */
  async getKeyring(vault: string): Promise<UnlockedKeyring> {
    const live = await this.deps.getKeyringInternal(vault)
    // Deep-ish defensive copy. Each container the consumer might
    // reasonably mutate is freshly cloned. CryptoKey handles inside
    // `deks` are intentionally shared — they're opaque references that
    // both encrypt and decrypt go through. `salt` (Uint8Array) is left
    // as-is: no realistic mutation path.
    return {
      ...live,
      deks: new Map(live.deks),
      permissions: { ...live.permissions },
      authenticators: live.authenticators.map((a) => ({
        ...a,
        meta: { ...a.meta },
      })),
      ...(live.policy !== undefined ? { policy: { ...live.policy } } : {}),
      ...(live.exportCapability !== undefined
        ? { exportCapability: { ...live.exportCapability } }
        : {}),
      ...(live.importCapability !== undefined
        ? { importCapability: { ...live.importCapability } }
        : {}),
    }
  }
}
