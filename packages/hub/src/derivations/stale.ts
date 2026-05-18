import type { DerivationStrategy } from './types.js'

/**
 * Mark every output id stale for this source-id. v1: in-memory only;
 * Task D11 (lazy lifecycle) fills this in.
 *
 * Typed structurally on the vault parameter to avoid a circular
 * `vault.ts → derivations → vault.ts` import. The caller (Collection.put)
 * passes `this.vault` (a string) or a vault-like accessor — the stub
 * ignores both arguments today.
 *
 * @internal
 */
export async function markStale(
  _vault: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _strategy: DerivationStrategy<any, any>,
  _sourceId: string,
): Promise<void> {
  // Stub — filled in by D11 (lazy lifecycle).
}
