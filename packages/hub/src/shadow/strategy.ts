/**
 * Strategy seam for the optional VaultFrame snapshot primitive.
 * Core imports `ShadowStrategy` as TYPE-ONLY and `NO_SHADOW` as a
 * 4-line stub. `VaultFrame` is only constructed inside `withShadow()`
 * — consumers who never import `@noy-db/hub/shadow` ship none of
 * the ~129 LOC.
 *
 * @internal
 */

import type { VaultFrame } from './vault-frame.js'

/**
 * @internal
 */
export interface ShadowStrategy {
  /**
   * Build a `VaultFrame` bound to the given vault. The factory type
   * is kept loose (`unknown`) to avoid a core → shadow type
   * dependency — the consumer always calls this through
   * `vault.frame()`, which returns `VaultFrame` at its surface.
   */
  buildFrame(vault: unknown): VaultFrame
}

const NOT_ENABLED = new Error(
  'VaultFrame requires the shadow strategy. Import `{ withShadow }` ' +
  'from "@noy-db/hub/shadow" and pass it to ' +
  '`createNoydb({ shadowStrategy: withShadow() })`.',
)

/**
 * No-shadow stub.
 *
 * @internal
 */
export const NO_SHADOW: ShadowStrategy = {
  buildFrame() { throw NOT_ENABLED },
}
