/**
 * Public `vault.custody.*` API surface (FR-6).
 *
 * The custody namespace is the vault-instance face of the FR-6 sovereign-custody
 * model — it mirrors `vault.user.*` exactly: a thin delegation shell with NO
 * business logic. The Vault constructs one `CustodyApi` per session, injecting
 * closures that bind the vault name / keyring into the genuinely-core
 * implementations (`Noydb.grantCustodian` / `Noydb.revokeCustodian` and the
 * `liberateVault` ceremony). Each method just forwards to its injected callback.
 *
 * Three operations:
 *  - `grantCustodian(opts)` — owner-only: mint a `custodian` who operates the
 *    vault fully but can never grant / rotate / sever / extract.
 *  - `revokeCustodian(opts)` — owner-only: remove a custodian.
 *  - `liberate(opts)` — custodian-only: audited claim of ownership over a
 *    sealed-owner (Deed) vault (mints a DISTINCT new owner; ledger-audited).
 *
 * Provisioning a Deed (`createDeedOwner`) is deliberately NOT on this class: it
 * is a store-level operation that mints the vault's first owner, so there is no
 * vault instance (and thus no custody namespace) yet — it stays the exported
 * `team/deed.ts` function.
 *
 * @see docs/superpowers/specs/2026-06-17-fr6-deed-custodian-liberate-design.md
 * @module
 */
import type { GrantOptions, RevokeOptions } from '../../kernel/types.js'
import type { FactorProofBundle } from '../../kernel/policy/types.js'
import type { LiberateOptions, LiberateResult } from './liberate.js'

/** Options for `vault.custody.grantCustodian` — a grant with the role fixed to `custodian`. */
export type GrantCustodianOptions = Omit<GrantOptions, 'role'>

// Capability opt-in seam (S4): grant/revoke custodian + liberate throw
// CustodyNotEnabledError unless `custodyStrategy: withCustody()` is opted in.
export { withCustody } from './active.js'
export { NO_CUSTODY, type CustodyStrategy, type CustodyHost } from './strategy.js'
export { CustodyNotEnabledError } from '../../kernel/errors.js'

/**
 * Implementation behind `vault.custody`. Constructed once per Vault. Holds the
 * injected, vault-bound implementations in closure; every method delegates with
 * no added logic (the owner-only / custodian-only / gate checks all live in the
 * injected implementations — `Noydb.grantCustodian` etc. and `liberateVault`).
 */
export class CustodyApi {
  constructor(
    /** Bound `Noydb.grantCustodian(this.name, ...)` — owner-only, gated. */
    private readonly _grantCustodian: (options: GrantCustodianOptions, factors?: FactorProofBundle) => Promise<void>,
    /** Bound `Noydb.revokeCustodian(this.name, ...)` — owner-only, gated. */
    private readonly _revokeCustodian: (options: RevokeOptions, factors?: FactorProofBundle) => Promise<void>,
    /** Bound `liberateVault(this, ...)` — custodian-only audited ownership claim. */
    private readonly _liberate: (opts: LiberateOptions) => Promise<LiberateResult>,
  ) {}

  /**
   * Owner-only: grant the FR-6 `custodian` role. The custodian operates every
   * collection (rw + access) but is provably unable to grant / revoke / rotate /
   * extract-and-sever. Defended in depth (gate + owner-only role check) inside
   * the injected `Noydb.grantCustodian`.
   */
  async grantCustodian(options: GrantCustodianOptions, factors?: FactorProofBundle): Promise<void> {
    return this._grantCustodian(options, factors)
  }

  /** Owner-only: revoke a custodian. */
  async revokeCustodian(options: RevokeOptions, factors?: FactorProofBundle): Promise<void> {
    return this._revokeCustodian(options, factors)
  }

  /**
   * Custodian-only: the audited claim of ownership over a sealed-owner (Deed)
   * vault. Mints a DISTINCT new owner re-wrapping the incumbent DEKs under a
   * fresh KEK (the latent owner is never impersonated), ledger-audited. See
   * {@link liberateVault}.
   */
  async liberate(opts: LiberateOptions): Promise<LiberateResult> {
    return this._liberate(opts)
  }
}
