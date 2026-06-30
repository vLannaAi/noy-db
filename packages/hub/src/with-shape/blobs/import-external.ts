/**
 * Import / bootstrap (reverse projection) — walk an existing bucket/prefix in an
 * {@link ObjectProjection} and build a master collection where each record
 * anchors one object, restoring the record-anchoring invariant for objects that
 * pre-date noy-db (or were written by another system). See as-aws-s3 §3.8.
 *
 * Idempotent: re-running re-adopts the same objects under the same record ids.
 */
import type { ObjectProjection } from './object-projection.js'

/** Minimal collection surface this utility needs (avoids importing the kernel). */
export interface ImportableCollection {
  get(id: string): Promise<unknown>
  put(id: string, record: unknown): Promise<unknown>
  blob(id: string): {
    adoptExternal(
      slot: string,
      ref: { key: string; size?: number; contentType?: string; public?: boolean; backlink?: string },
    ): Promise<void>
  }
}

export interface ImportExternalOptions {
  /** Only consider objects under this key prefix. Default `''` (all). */
  prefix?: string
  /**
   * Derive the record id for an object key. Default: the path segment before
   * the last — i.e. `{collection}/{recordId}/{field}` → `recordId`. Return
   * `null` to skip the object.
   */
  deriveRecordId?: (key: string) => string | null
  /** Build the anchor record for a new id. Default `{ id }`. */
  makeRecord?: (id: string) => unknown
}

export interface ImportExternalResult {
  imported: number
  skipped: number
  recordIds: string[]
}

function defaultDeriveRecordId(key: string): string | null {
  const parts = key.split('/')
  return parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null
}

/**
 * Build/extend `collection` from the objects under `prefix` in `objectStore`,
 * adopting each as the `field` blob on its derived record.
 */
export async function importExternalObjects(args: {
  collection: ImportableCollection
  objectStore: ObjectProjection
  field: string
  options?: ImportExternalOptions
}): Promise<ImportExternalResult> {
  const { collection, objectStore, field } = args
  const opts = args.options ?? {}
  const derive = opts.deriveRecordId ?? defaultDeriveRecordId
  const makeRecord = opts.makeRecord ?? ((id: string) => ({ id }))

  const objects = await objectStore.listPrefix(opts.prefix ?? '')
  const recordIds: string[] = []
  let imported = 0
  let skipped = 0

  for (const { key, meta } of objects) {
    const recordId = derive(key)
    if (!recordId) {
      skipped++
      continue
    }
    if ((await collection.get(recordId)) == null) {
      await collection.put(recordId, makeRecord(recordId))
    }
    await collection.blob(recordId).adoptExternal(field, {
      key,
      ...(meta.size !== undefined ? { size: meta.size } : {}),
      ...(meta.contentType ? { contentType: meta.contentType } : {}),
    })
    recordIds.push(recordId)
    imported++
  }

  return { imported, skipped, recordIds }
}
