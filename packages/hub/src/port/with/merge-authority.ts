/**
 * The merge's capability to verify and re-stamp store-supplied ciphertext (#1042).
 *
 * ## The problem this seam exists to solve
 *
 * `with-sync` is DEK-free by design, and `check:architecture` enforces it: the
 * engine's only enclave import is shape predicates. That is why AAD alone
 * cannot make the merge fail closed — AAD is verified inside `subtle.decrypt`,
 * and `applyRemote` never decrypts. It commits the remote envelope and the
 * client discovers the problem at read time, *after* its own newer copy is
 * gone.
 *
 * Two consequences follow from the same root, and one seam resolves both:
 *
 *  1. **The merge cannot reject a forged envelope**, because it holds no key.
 *  2. **`advancePastRemote` re-stamps `_v` on existing ciphertext** without a
 *     DEK, which is precisely why `_v` could not be bound into the AAD by
 *     #1041. Version rollback stayed open as a result.
 *
 * ## Why a capability rather than an import
 *
 * The engine takes a `MergeAuthority` at construction. The closure holds the
 * DEK; the engine's import graph is unchanged, so `check:architecture` passes
 * **unweakened** — no allowlist entry, no guard edit. ADR 0003 states the test
 * plainly: *if the guard needs relaxing, the design is wrong.*
 *
 * @packageDocumentation
 */
import type { EncryptedEnvelope } from '../../kernel/types.js'

export interface MergeAuthority {
  /**
   * Does `envelope` authenticate at the identity and version it claims?
   *
   * Called **before** `local.put`, so a rejection costs the client nothing: its
   * existing copy is untouched. Returns a boolean rather than throwing because
   * a hostile store must not be able to halt an entire sync by poisoning one
   * record — the caller records the rejection and moves to the next entry.
   */
  verify(collection: string, id: string, envelope: EncryptedEnvelope): Promise<boolean>

  /**
   * Re-stamp `envelope` to `toVersion`, re-sealing it under the same DEK.
   *
   * Replaces the `{ ...winner, _v: remote._v + 1 }` spread. That spread is the
   * single reason `_v` is not yet AEAD-bound: it rewrites a version onto
   * ciphertext nobody re-sealed, so a reader recomputing AAD from the stamped
   * `_v` would find a body sealed at a different one.
   *
   * With this, advancing becomes a re-seal, and binding `_v` becomes possible —
   * which converts rollback detection into rollback *prevention*.
   */
  advance(
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    toVersion: number,
  ): Promise<EncryptedEnvelope>
}
