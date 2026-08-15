/**
 * Builds the {@link MergeAuthority} the sync engine verifies with (#1042).
 *
 * ## Why it lives in the kernel and not in `with-sync`
 *
 * `with-sync` is DEK-free by design and `check:architecture` enforces it, so
 * the engine cannot verify anything itself: AAD is checked inside
 * `subtle.decrypt`, and the merge never decrypts. The capability is therefore
 * built here — where the keyring is — and handed in already bound to the keys.
 * The engine's import graph is unchanged, so the guard passes **unweakened**.
 *
 * ## Why its own module rather than inline in `noydb.ts`
 *
 * The `kernel-surface` ceiling refused it inline, and the ceiling was right: a
 * 33-line capability is not spine plumbing. `noydb.ts` now calls a one-line
 * factory.
 *
 * @packageDocumentation
 */
import { verifyRecordIdentity } from './enclave/index.js'
import { dekKey } from './tier-visibility.js'
import type { MergeAuthority } from '../port/with/merge-authority.js'
import type { EnclaveKey } from './enclave/index.js'

/**
 * ⚠️ **A client cannot verify what it cannot decrypt** — and that boundary is
 * stated here rather than hidden.
 *
 * A record at a tier this caller holds no key for is accepted **unverified**.
 * Rejecting it would break replication of data the peer legitimately holds but
 * this client is not cleared to read, converting a confidentiality boundary
 * into a replication failure. The residue is narrow: envelopes whose key the
 * client lacks are pass-through, exactly as every envelope was before #1042.
 *
 * Closing that residue needs the vault head (#1044), which can detect absence
 * and substitution without holding the key.
 */
export function buildMergeAuthority(
  /**
   * Just the DEK map, not the whole keyring. `port-layering` refused a type
   * import of `UnlockedKeyring` from `with-party` — correctly, and the narrower
   * shape is better anyway: this needs to look up keys, not to know what a
   * keyring is.
   */
  keyring: { readonly deks: ReadonlyMap<string, EnclaveKey> },
): MergeAuthority {
  return {
    verify: async (collection, id, envelope) => {
      const dek = keyring.deks.get(dekKey(collection, envelope._tier ?? 0))
      if (dek === undefined) return true // no key → cannot judge; see above
      return verifyRecordIdentity({ collection, id }, envelope, dek)
    },

    advance: async (_collection, _id, envelope, toVersion) => {
      // `_v` is not yet AEAD-bound, so advancing is still a metadata restamp.
      // The seam exists so binding it becomes a change HERE rather than a hunt
      // through the engine — see port/with/merge-authority.ts.
      return { ...envelope, _v: toVersion }
    },
  }
}
