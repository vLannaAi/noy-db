/**
 * C-A / R10 config-drift marker I/O — the store side of the guard, kept OUT of
 * the kernel `Collection` so the always-on kernel surface stays lean. The
 * kernel holds only the per-handle memoization; these helpers do the actual
 * persisted-schema read/write (via the persisted-schemas storage seam, lazily
 * imported so the classified spine tree-shakes).
 *
 * Marker semantics: a collection declaring classified digest-only fields writes
 * an `x-classified` marker into its `_schemas/<collection>` record on the first
 * classified write. A handle later opened WITHOUT `classifiedFields` (a naive
 * handle) reads it back and refuses to write — see RecordCodec.encryptRecord's
 * R10 guard.
 *
 * @module
 */
import type { NoydbStore, VdigFieldPolicy, ClassifiedMarker } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'

/** Build the marker for a handle's digest-only field map, or null when it declares none. */
function markerForFields(vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null): ClassifiedMarker | null {
  if (vdigFields === null || vdigFields.size === 0) return null
  const digestOnly = [...vdigFields.keys()]
  return { digestOnly, equatable: digestOnly.filter((f) => vdigFields.get(f)?.equatable === true) }
}

/**
 * Persist the classified marker for a handle's digest-only fields. No-op when
 * the handle declares none. Idempotent (delegates to `persistClassifiedMarker`).
 */
export async function persistClassifiedMarkerForFields(
  store: NoydbStore,
  vault: string,
  collectionName: string,
  vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null,
  dek: EnclaveKey,
): Promise<void> {
  const marker = markerForFields(vdigFields)
  if (marker === null) return
  const { persistClassifiedMarker } = await import('../persisted-schemas/register.js')
  await persistClassifiedMarker({ store, vault, collectionName, dek, marker })
}

/** Read whether a collection carries a persisted classified marker (cross-session drift signal). */
export async function readClassifiedMarkerPresent(
  store: NoydbStore,
  vault: string,
  collectionName: string,
  dek: EnclaveKey,
): Promise<boolean> {
  const { loadPersistedSchema } = await import('../persisted-schemas/storage.js')
  const persisted = await loadPersistedSchema(store, vault, collectionName, dek)
  return (persisted?.classified?.digestOnly.length ?? 0) > 0
}
