/**
 * Lazy factory for the store-backed default {@link CoordinationProvider}.
 * `with-shape/schema-update` is service-layer code the kernel spine may not
 * statically import — the dynamic `import()` below is the port-layering
 * law's sanctioned escape hatch for this exact case.
 */
import type { NoydbStore } from '../../kernel/types.js'
export type { CoordinationProvider } from './types.js'

export async function createDefaultCoordinationProvider(store: NoydbStore) {
  const { StoreCoordinationProvider } = await import('../../with-shape/schema-update/store-coordination-provider.js')
  return new StoreCoordinationProvider(store)
}
