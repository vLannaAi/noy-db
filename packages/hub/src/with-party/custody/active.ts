/**
 * Enable the sovereign-custody (FR-6) capability.
 * Pass to `createNoydb({ custodyStrategy: withCustody() })` to make
 * `db.grantCustodian` / `db.revokeCustodian` (and the `vault.custody.*` facade
 * that delegates to them) plus `vault.custody.liberate()` live. The heavy
 * `liberateVault` ceremony is dynamically imported here, so it is reached only
 * via opt-in; grant/revoke run the host's own gate + keyring engine.
 */
import type { CustodyStrategy } from './strategy.js'

export function withCustody(): CustodyStrategy {
  return {
    async grantCustodian(host, vault, options, factors) {
      return host._grantCustodianImpl(vault, options, factors)
    },
    async revokeCustodian(host, vault, options, factors) {
      return host._revokeCustodianImpl(vault, options, factors)
    },
    async liberate(vault, opts) {
      const { liberateVault } = await import('./liberate.js')
      return liberateVault(vault, opts)
    },
  }
}
