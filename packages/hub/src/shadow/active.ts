/**
 * Active shadow strategy — the only place `VaultFrame` is constructed.
 * Only reachable through `@noy-db/hub/shadow`.
 */

import { VaultFrame } from './vault-frame.js'
import type { ShadowStrategy } from './strategy.js'
import type { Vault } from '../vault.js'

export function withShadow(): ShadowStrategy {
  return {
    buildFrame(vault) { return new VaultFrame(vault as Vault) },
  }
}
