/**
 * Enable the cargo (partition extraction) capability.
 * Pass to `createNoydb({ cargoStrategy: withCargo() })` to make the source-side
 * `extractPartition(vault, ...)` free function live. The extraction crypto
 * engine is dynamically imported here, so it stays out of the floor bundle
 * until opted in. The recipient-side `adoptPartition` /
 * `decryptExtractedPartition` free functions — and `diffVault` (shared
 * import/merge infra) — are ungated and unaffected.
 */
import type { CargoStrategy } from './strategy.js'

export function withCargo(): CargoStrategy {
  return {
    async extractPartition(vault, opts) {
      const { extractPartitionCore } = await import('./extract-partition.js')
      return extractPartitionCore(vault, opts)
    },
  }
}
