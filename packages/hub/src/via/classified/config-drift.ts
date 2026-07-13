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
 * `dek` is typed as the bare `CryptoKey` global rather than `EnclaveKey`
 * (`kernel/enclave/crypto.ts`'s alias for the same type) — this file lives
 * under `via/classified/`, which the `via-enclave-isolation`
 * architecture guard (#629) forbids from importing `kernel/enclave/` at
 * all, even type-only.
 *
 * @module
 */
import type { NoydbStore, VdigFieldPolicy, ClassifiedMarker } from '../../kernel/types.js'

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
  dek: CryptoKey,
): Promise<void> {
  const marker = markerForFields(vdigFields)
  if (marker === null) return
  const { persistClassifiedMarker } = await import('../../with-shape/persisted-schemas/register.js')
  await persistClassifiedMarker({ store, vault, collectionName, dek, marker })
}

/**
 * Read a collection's persisted classified marker's declared digest-only field
 * set (empty when the collection carries no marker). Cross-session drift signal:
 * the R10 superset guard refuses a handle whose declared classified set does not
 * cover every field in this set.
 */
export async function readClassifiedMarkerDigestOnly(
  store: NoydbStore,
  vault: string,
  collectionName: string,
  dek: CryptoKey,
): Promise<readonly string[]> {
  const { loadPersistedSchema } = await import('../../with-shape/persisted-schemas/storage.js')
  const persisted = await loadPersistedSchema(store, vault, collectionName, dek)
  return persisted?.classified?.digestOnly ?? []
}
