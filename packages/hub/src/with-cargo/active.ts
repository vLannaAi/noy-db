/**
 * Enable the cargo (partition extraction / vault diff) capability.
 * Pass to `createNoydb({ cargoStrategy: withCargo() })` to make the source-side
 * `extractPartition(vault, ...)` and `diffVault(vault, ...)` free functions
 * live. The extraction crypto engine and the diff walk are dynamically imported
 * here, so they stay out of the floor bundle until opted in. The recipient-side
 * `adoptPartition` / `decryptExtractedPartition` free functions are ungated
 * host-side tooling (no source instance to gate against) and are unaffected.
 */
import type { CargoStrategy } from './strategy.js'

export function withCargo(): CargoStrategy {
  return {
    async extractPartition(vault, opts) {
      const { extractPartitionCore } = await import('./extract-partition.js')
      return extractPartitionCore(vault, opts)
    },
    async diffVault(vault, candidate, options) {
      const { diffVaultCore } = await import('./vault-diff.js')
      return diffVaultCore(vault, candidate, options)
    },
  }
}
