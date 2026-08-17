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
import { verifyRecordIdentity, rewrapBodyToDek, applyRewrappedBody, hasSealedBody } from './enclave/index.js'
import { dekKey } from './tier-visibility.js'
import { ValidationError } from './errors.js'
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

    advance: async (collection, id, envelope, toVersion) => {
      // A tombstone and a plaintext record carry no sealed body, so there is
      // nothing to re-seal and the stamp alone is the whole operation. Same
      // vacuous-authenticity rule `verifyRecordIdentity` applies.
      if (!hasSealedBody(envelope)) return { ...envelope, _v: toVersion }

      const dek = keyring.deks.get(dekKey(collection, envelope._tier ?? 0))
      if (dek === undefined) {
        // Unreachable through the sync engine, and stated loudly rather than
        // papered over: `advance` is only called on a local-wins conflict, and
        // a client cannot have written — hence cannot hold a dirty entry for —
        // a collection it holds no key for. Restamping anyway would emit an
        // envelope sealed at one version and labelled another: a record nobody,
        // including its author, can ever open again.
        throw new ValidationError(
          `sync: cannot advance "${collection}/${id}" past the remote — no key for it, so its body ` +
          'cannot be re-sealed at the new version. The local copy is unchanged.',
        )
      }

      // `_v` is inside the AAD (#1093), so advancing a version is a RE-SEAL,
      // not an edit. `rewrapBodyToDek` with the same DEK on both ends is
      // exactly that: open under the identity the body currently has, re-seal
      // under the one it is moving to. The per-record CEK is preserved, so the
      // history chain's body-key identity survives the advance.
      const from = {
        collection, id,
        version: envelope._v,
        ...(envelope._tier !== undefined ? { tier: envelope._tier } : {}),
        ...(envelope._by !== undefined ? { by: envelope._by } : {}),
      }
      const body = await rewrapBodyToDek(from, { ...from, version: toVersion }, envelope, dek, dek)
      return { ...applyRewrappedBody(envelope, body), _v: toVersion }
    },
  }
}
