/**
 * Sovereign-custody (FR-6) capability strategy — the three on-demand
 * operations the custody surface routes through: minting a custodian
 * (`grantCustodian`), removing one (`revokeCustodian`), and the audited
 * ownership-claim ceremony (`liberate`). The active engine ({@link withCustody})
 * runs the grant/revoke impls the host exposes and dynamically imports the
 * heavy `liberateVault` ceremony (keeping it out of the floor bundle);
 * {@link NO_CUSTODY} throws.
 *
 * `Noydb.grantCustodian` / `Noydb.revokeCustodian` delegate here (passing
 * themselves as the {@link CustodyHost}), and `vault.custody.liberate` delegates
 * here with its {@link Vault}. An un-opted-in caller hits `NO_CUSTODY`'s throw.
 *
 * Note: the lower-level `liberateVault` FREE FUNCTION (exported from
 * `custody/liberate.ts`) stays ungated — it has no `createNoydb` instance to
 * gate against (the same carve-out as the `openSealedRecord` host opener). Only
 * the instance surfaces (`db.grantCustodian` / `db.revokeCustodian` /
 * `vault.custody.*`) are the capability.
 * @internal
 */
import type { RevokeOptions } from '../../kernel/types.js'
import type { FactorProofBundle } from '../../kernel/policy/types.js'
import type { Vault } from '../../kernel/vault.js'
import type { GrantCustodianOptions } from './index.js'
import type { LiberateOptions, LiberateResult } from './liberate.js'
import { CustodyNotEnabledError } from '../../kernel/errors.js'

/**
 * The grant/revoke engine the strategy runs when opted in — implemented by
 * `Noydb` (`_grantCustodianImpl` / `_revokeCustodianImpl` hold the gate +
 * keyring logic; the public `grantCustodian` / `revokeCustodian` route through
 * the strategy).
 */
export interface CustodyHost {
  _grantCustodianImpl(vault: string, options: GrantCustodianOptions, factors?: FactorProofBundle): Promise<void>
  _revokeCustodianImpl(vault: string, options: RevokeOptions, factors?: FactorProofBundle): Promise<void>
}

export interface CustodyStrategy {
  grantCustodian(host: CustodyHost, vault: string, options: GrantCustodianOptions, factors?: FactorProofBundle): Promise<void>
  revokeCustodian(host: CustodyHost, vault: string, options: RevokeOptions, factors?: FactorProofBundle): Promise<void>
  liberate(vault: Vault, opts: LiberateOptions): Promise<LiberateResult>
}

/**
 * No-op stub — the floor default. Every custody operation throws
 * {@link CustodyNotEnabledError}; opt in with `custodyStrategy: withCustody()`
 * in createNoydb. @internal
 */
export const NO_CUSTODY: CustodyStrategy = {
  async grantCustodian() { throw new CustodyNotEnabledError() },
  async revokeCustodian() { throw new CustodyNotEnabledError() },
  async liberate() { throw new CustodyNotEnabledError() },
}
