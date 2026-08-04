/**
 * The reserved `_manifest` collection — one record per pod, holding the
 * manifest-set (schema / behavior / storage / access / app manifests, per
 * the manifest-engine roadmap #941). A single collection is gated: records
 * inside it are keyed by manifest kind. Only `schema` (record id `schema`)
 * is implemented (#941, P0); `behavior`/`storage`/`access`/`app` are
 * reserved record ids for future kinds (P1-P3) — not built yet.
 *
 * Reserved so `vault.collection('_manifest')` is refused (manifests are
 * privileged, strict-CAS, ledger-audited records — never reachable through
 * the generic public collection handle) and so the collection travels in a
 * pod dump like every other reserved internal collection.
 *
 * Kept dependency-free (mirrors `with-party/team/reserved-secret-collections.ts`)
 * so both the kernel (`vault.ts`) and other shape-layer modules can import it
 * without an import cycle.
 */

/** Reserved collection holding the pod's manifest-set records. */
export const MANIFEST_COLLECTION = '_manifest' as const

/**
 * The set of reserved manifest collection names. Currently just the single
 * `_manifest` collection — record ids inside it (not collection names)
 * distinguish manifest kinds.
 */
export const MANIFEST_RESERVED_COLLECTIONS: ReadonlySet<string> = new Set([
  MANIFEST_COLLECTION,
])

/** True when `name` is a reserved manifest collection. */
export function isManifestReservedCollection(name: string): boolean {
  return MANIFEST_RESERVED_COLLECTIONS.has(name)
}
