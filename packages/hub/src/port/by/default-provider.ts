/**
 * Lazy factory for the store-backed default {@link NoydbMesh}.
 * `with-shape/schema-update` is service-layer code the kernel spine may not
 * statically import — the dynamic `import()` below is the port-layering
 * law's sanctioned escape hatch for this exact case.
 */
import type { NoydbStore } from '../../kernel/types.js'
export type { NoydbMesh } from './types.js'

export async function createDefaultMesh(store: NoydbStore) {
  const { StoreMesh } = await import('../../with-shape/schema-update/store-coordination-provider.js')
  return new StoreMesh(store)
}
