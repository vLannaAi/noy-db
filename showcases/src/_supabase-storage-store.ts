/**
 * NoydbStore wrapper around Supabase Storage (the project's bucket
 * service, not the Postgres database).
 *
 * Supabase Storage is S3-compatible at the wire level, but the
 * canonical access path from JavaScript is the official
 * `@supabase/supabase-js` client's `.storage.from(bucket)` API. This
 * wrapper maps that API to the same `NoydbStore` 6-method contract
 * the rest of NOYDB expects, with the same key scheme as `to-aws-s3`
 * (`{prefix}/{vault}/{collection}/{id}.json`).
 *
 * Why this lives in showcases/ rather than as `@noy-db/to-supabase-storage`:
 * the existing `@noy-db/to-supabase` deliberately does NOT embed
 * `@supabase/supabase-js` to keep the package small (the SDK is a
 * sizable transitive — websockets, fetch polyfills, an auth module).
 * Supporting Storage natively would re-introduce that dependency. For
 * production deployments, adopters can either:
 *   - Use this wrapper (vendor-copy from showcases/)
 *   - Or use `@noy-db/to-aws-s3` pointed at Supabase's S3-compat
 *     endpoint (https://<ref>.storage.supabase.co/storage/v1/s3) with
 *     S3-compat access keys generated under Storage settings.
 *
 * @module
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
} from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'

export interface SupabaseStorageStoreOptions {
  readonly client: SupabaseClient
  readonly bucket: string
  readonly prefix?: string
  /**
   * Try to create the bucket if it doesn't exist on first use. The
   * service-role key has the permission to create buckets, so this is
   * convenient for showcase / dev. Set false in production if buckets
   * are managed out-of-band.
   */
  readonly autoCreateBucket?: boolean
}

export function supabaseStorage(options: SupabaseStorageStoreOptions): NoydbStore {
  const client = options.client
  const bucketName = options.bucket
  const prefix = options.prefix ?? ''
  const autoCreate = options.autoCreateBucket ?? true
  let bucketReady: Promise<void> | null = null

  function path(vault: string, collection: string, id: string): string {
    const parts = [vault, collection, `${id}.json`]
    return prefix ? `${prefix}/${parts.join('/')}` : parts.join('/')
  }

  function collFolder(vault: string, collection: string): string {
    const parts = [vault, collection]
    return prefix ? `${prefix}/${parts.join('/')}` : parts.join('/')
  }

  function vaultFolder(vault: string): string {
    return prefix ? `${prefix}/${vault}` : vault
  }

  async function ensureBucket(): Promise<void> {
    if (!autoCreate) return
    if (!bucketReady) {
      bucketReady = (async () => {
        const { data: buckets, error } = await client.storage.listBuckets()
        if (error) throw new Error(`Supabase Storage listBuckets failed: ${error.message}`)
        if (!buckets?.find((b) => b.name === bucketName)) {
          const { error: createErr } = await client.storage.createBucket(bucketName, {
            public: false,
          })
          if (createErr && !/already exists/i.test(createErr.message)) {
            throw new Error(`Supabase Storage createBucket failed: ${createErr.message}`)
          }
        }
      })()
    }
    await bucketReady
  }

  const bucket = () => client.storage.from(bucketName)

  return {
    name: 'supabase-storage',

    async get(vault, collection, id): Promise<EncryptedEnvelope | null> {
      await ensureBucket()
      const { data, error } = await bucket().download(path(vault, collection, id))
      if (error) {
        // 404 is the canonical "not found"; treat any not-found-flavoured
        // error as null. Other errors propagate.
        const msg = (error as { message?: string }).message ?? String(error)
        if (/not.?found|404|object not found|no such key/i.test(msg)) return null
        throw new Error(`Supabase Storage download failed: ${msg}`)
      }
      const text = await data.text()
      return JSON.parse(text) as EncryptedEnvelope
    },

    async put(vault, collection, id, envelope, expectedVersion?): Promise<void> {
      await ensureBucket()
      const key = path(vault, collection, id)
      // Storage has no native CAS — replicate the read-then-write
      // pattern from to-aws-s3. Same race window applies.
      if (expectedVersion !== undefined) {
        const { data, error } = await bucket().download(key)
        if (error) {
          const msg = (error as { message?: string }).message ?? String(error)
          if (/not.?found|404|object not found|no such key/i.test(msg)) {
            if (expectedVersion !== 0) {
              throw new ConflictError(0, `Record ${vault}/${collection}/${id} does not exist (expected v=${expectedVersion})`)
            }
          } else {
            throw new Error(`Supabase Storage download (CAS check) failed: ${msg}`)
          }
        } else {
          const got = JSON.parse(await data.text()) as EncryptedEnvelope
          if (got._v !== expectedVersion) {
            throw new ConflictError(got._v, `Version mismatch on ${key}: expected ${expectedVersion}, found ${got._v}`)
          }
        }
      }
      // Pass a Uint8Array (not Blob) — supabase-js's internal fetch
      // transport has a known issue in Node where Blob bodies emit
      // "Request stream closed before upload could begin". Bytes work
      // reliably and produce the same on-disk content.
      const body = new TextEncoder().encode(JSON.stringify(envelope))
      const { error } = await bucket().upload(key, body, {
        upsert: true,
        contentType: 'application/json',
      })
      if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`)
    },

    async delete(vault, collection, id): Promise<void> {
      await ensureBucket()
      const { error } = await bucket().remove([path(vault, collection, id)])
      if (error) throw new Error(`Supabase Storage remove failed: ${error.message}`)
    },

    async list(vault, collection): Promise<string[]> {
      await ensureBucket()
      const folder = collFolder(vault, collection)
      const { data, error } = await bucket().list(folder, { limit: 1000 })
      if (error) {
        const msg = (error as { message?: string }).message ?? String(error)
        if (/not.?found/i.test(msg)) return []
        throw new Error(`Supabase Storage list failed: ${msg}`)
      }
      return (data ?? [])
        .filter((o) => o.name.endsWith('.json'))
        .map((o) => o.name.slice(0, -'.json'.length))
    },

    async loadAll(vault): Promise<VaultSnapshot> {
      await ensureBucket()
      // Storage's list() doesn't support recursive listing — we have to
      // walk one folder at a time. List the vault folder, then list each
      // collection subfolder.
      const snapshot: VaultSnapshot = {}
      const folder = vaultFolder(vault)
      const { data: collections, error: cErr } = await bucket().list(folder, { limit: 1000 })
      if (cErr) {
        const msg = (cErr as { message?: string }).message ?? String(cErr)
        if (/not.?found/i.test(msg)) return snapshot
        throw new Error(`Supabase Storage list failed: ${msg}`)
      }
      for (const collEntry of collections ?? []) {
        // Sub-folders show up as entries with an `id` of null.
        if (collEntry.id !== null) continue
        const collFolderPath = `${folder}/${collEntry.name}`
        const { data: items } = await bucket().list(collFolderPath, { limit: 1000 })
        for (const item of items ?? []) {
          if (!item.name.endsWith('.json')) continue
          const id = item.name.slice(0, -'.json'.length)
          const got = await this.get(vault, collEntry.name, id)
          if (got) {
            if (!snapshot[collEntry.name]) snapshot[collEntry.name] = {}
            snapshot[collEntry.name]![id] = got
          }
        }
      }
      return snapshot
    },

    async saveAll(vault, data): Promise<void> {
      await ensureBucket()
      // Best-effort: drop existing vault contents, write the new snapshot.
      // Same shape as to-aws-s3.saveAll.
      const folder = vaultFolder(vault)
      const { data: subfolders } = await bucket().list(folder, { limit: 1000 })
      for (const sf of subfolders ?? []) {
        if (sf.id !== null) continue
        const collPath = `${folder}/${sf.name}`
        const { data: items } = await bucket().list(collPath, { limit: 1000 })
        if (!items || items.length === 0) continue
        await bucket().remove(items.map((i) => `${collPath}/${i.name}`))
      }
      for (const [collection, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records ?? {})) {
          await this.put(vault, collection, id, envelope)
        }
      }
    },
  }
}
