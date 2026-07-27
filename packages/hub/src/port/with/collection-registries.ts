/**
 * Vault-level registries a collection declaration populates (#841).
 *
 * `Vault.collection()` carried ~70 lines that did nothing but fan a
 * declaration out into ten registries — refs, i18n fields, blob retention,
 * archive policy, attestation schema, the dict/lookup family, and the
 * schema-update names. None of it is orchestration, and all of it obscured
 * the method's actual job.
 *
 * ## Why this is on the port and not in `kernel/`
 *
 * The registry types reach into services — `BlobFieldsConfig`
 * (`with-shape/blobs`) and `ArchivePolicy` (`with-fork/archive`) — and
 * `port-layering` forbids the spine from statically importing a `with-*`
 * module, **including type-only** (the guard scans import statements, not
 * their erasure). Port files may reach services freely, which is why
 * `strategies.ts` and `collection-options.ts` already live here.
 *
 * @internal
 */

import type { AttestationFieldSchema } from '@noy-db/attestation'

import type { BlobFieldsConfig } from '../../with-shape/blobs/blob-compaction.js'
import type { ArchivePolicy } from '../../with-fork/archive/index.js'
import type { OpenCollectionOptions } from './collection-options.js'
import { isStaticDictDescriptor, type StaticDictDescriptor } from './i18n-strategy.js'
import { collectLookupDictCompat, dictCollectionName, type LookupDescriptor } from './lookup-strategy.js'

/** The via-derived field maps a declaration resolves to before registration. */
export interface EffectiveViaFields {
  readonly i18nFields?: Record<string, unknown> | undefined
  readonly dictKeyFields?: Record<string, StaticDictDescriptor | { name: string }> | undefined
  readonly lookupFields?: Record<string, LookupDescriptor<string>> | undefined
}

/**
 * The ten registries a collection declaration writes into. Passed by
 * reference — these are the Vault's own maps, mutated in place.
 */
export interface CollectionRegistries {
  readonly refRegistry: { register(collection: string, refs: Record<string, unknown>): void }
  readonly i18nFieldRegistry: Map<string, unknown>
  readonly blobFieldsRegistry: Map<string, BlobFieldsConfig<unknown>>
  readonly archiveRegistry: Map<string, ArchivePolicy>
  readonly attestation: { register(collection: string, schema: AttestationFieldSchema): void }
  readonly dictKeyFieldRegistry: Map<string, Record<string, string>>
  readonly staticDictNames: Set<string>
  readonly staticByName: Map<string, StaticDictDescriptor>
  readonly staticDescriptorByField: Map<string, Record<string, StaticDictDescriptor>>
  readonly reservedLookupCollections: Map<string, string>
  readonly schemaUpdateNames: Map<string, string[]>
}

/**
 * Fan a collection declaration out into the vault's registries.
 *
 * Called once, before the `Collection` is constructed, so the first `put()`
 * already sees its refs through `vault.enforceRefsOnPut`.
 */
export function populateCollectionRegistries<T>(
  r: CollectionRegistries,
  collectionName: string,
  options: OpenCollectionOptions<T> | undefined,
  effectiveViaFields: EffectiveViaFields,
): void {
  // Register ref declarations (if any) with the vault-level
  // registry BEFORE constructing the Collection. This way the
  // first put() on the new collection already sees its refs via
  // vault.enforceRefsOnPut.
  if (options?.refs) {
    r.refRegistry.register(collectionName, options.refs)
  }

  // Register i18nText fields
  if (effectiveViaFields.i18nFields) {
    r.i18nFieldRegistry.set(collectionName, effectiveViaFields.i18nFields)
  }

  // register blobFields retention/TTL policy
  if (options?.blobFields) {
    r.blobFieldsRegistry.set(collectionName, options.blobFields as BlobFieldsConfig<unknown>)
  }

  // register record archival policy
  if (options?.archive) {
    r.archiveRegistry.set(collectionName, options.archive as ArchivePolicy)
  }

  // register the per-collection attestation field-schema
  if (options?.attestation !== undefined) {
    r.attestation.register(collectionName, options.attestation)
  }

  // Register dictKey / staticDict fields. Plain dictKey fields go into
  // the rename-tracking registry; staticDict fields skip it (no
  // per-vault pointer rewrite) and instead populate the static
  // registries that back the read-path resolver, the readonly guard, and
  // put-time code validation. Native lookup()/dict() reserved/static
  // fields fold into the SAME registries (#650 Task 2 — collectLookupDictCompat).
  if (effectiveViaFields.dictKeyFields || effectiveViaFields.lookupFields) {
    const dictFieldMap: Record<string, string> = {}
    const staticFieldMap: Record<string, StaticDictDescriptor> = {}
    for (const [field, desc] of Object.entries(effectiveViaFields.dictKeyFields ?? {})) {
      if (isStaticDictDescriptor(desc)) {
        staticFieldMap[field] = desc
        r.staticDictNames.add(desc.name)
        r.staticByName.set(desc.name, desc)
      } else {
        dictFieldMap[field] = desc.name
      }
    }
    const lookupCompat = collectLookupDictCompat(effectiveViaFields.lookupFields)
    Object.assign(dictFieldMap, lookupCompat.dictFieldMap)
    for (const [field, desc] of lookupCompat.staticEntries) {
      staticFieldMap[field] = desc
      r.staticDictNames.add(desc.name)
      r.staticByName.set(desc.name, desc)
    }
    if (Object.keys(dictFieldMap).length > 0) {
      r.dictKeyFieldRegistry.set(collectionName, dictFieldMap)
      // #650 Task 4 (#647) — declare these dimensions' _dict_* collections into the
      // reserved-lookup sync registry NOW, at schema-declare time — before any local
      // dictionary() call/write/read touches them this session.
      for (const dictName of new Set(Object.values(dictFieldMap))) {
        r.reservedLookupCollections.set(dictCollectionName(dictName), dictName)
      }
    }
    if (Object.keys(staticFieldMap).length > 0) {
      r.staticDescriptorByField.set(collectionName, staticFieldMap)
    }
  }

  // Capture registered schema-update strategy names for introspection.
  if ((options?.schemaUpdate?.length ?? 0) > 0) {
    r.schemaUpdateNames.set(collectionName, (options!.schemaUpdate ?? []).map((s) => s.name))
  }
}
