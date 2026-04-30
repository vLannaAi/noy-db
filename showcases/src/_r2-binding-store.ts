/// <reference types="@cloudflare/workers-types" />
/**
 * NoydbStore wrapper around the Cloudflare Worker R2 binding (`env.BUCKET`).
 *
 * `@noy-db/to-cloudflare-r2` only supports the S3-compat auth surface
 * (Access Key ID + Secret Access Key, used over HTTPS). When you're
 * running inside a Worker, the canonical access path is the
 * `R2Bucket` binding object — an in-process API with `.put / .get /
 * .delete / .list`. This wrapper maps that binding to the same
 * `NoydbStore` 6-method contract, with the same key scheme as the S3
 * version (`{prefix}/{vault}/{collection}/{id}.json`) so envelopes
 * written via S3 from outside the Worker are readable via the binding
 * from inside, and vice versa.
 *
 * Used by showcase 63 only. If a future Worker-context use case
 * needs this beyond a showcase, it should graduate to a real package
 * (`@noy-db/to-cloudflare-r2-binding` or fold into `to-cloudflare-r2`
 * with a `client | binding` discriminated union).
 *
 * @module
 */

import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
} from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'

export interface R2BindingStoreOptions {
  readonly bucket: R2Bucket
  readonly prefix?: string
}

export function r2Binding(options: R2BindingStoreOptions): NoydbStore {
  const bucket = options.bucket
  const prefix = options.prefix ?? ''

  function objectKey(vault: string, collection: string, id: string): string {
    const parts = [vault, collection, `${id}.json`]
    return prefix ? `${prefix}/${parts.join('/')}` : parts.join('/')
  }

  function collPrefix(vault: string, collection: string): string {
    const parts = [vault, collection, '']
    return prefix ? `${prefix}/${parts.join('/')}` : parts.join('/')
  }

  function vaultPrefix(vault: string): string {
    const parts = [vault, '']
    return prefix ? `${prefix}/${parts.join('/')}` : parts.join('/')
  }

  return {
    name: 'r2-binding',

    async get(vault, collection, id): Promise<EncryptedEnvelope | null> {
      const obj = await bucket.get(objectKey(vault, collection, id))
      if (!obj) return null
      const text = await obj.text()
      return JSON.parse(text) as EncryptedEnvelope
    },

    async put(vault, collection, id, envelope, expectedVersion?): Promise<void> {
      const key = objectKey(vault, collection, id)
      // R2 has no native CAS. Replicate `to-aws-s3`'s read-then-write
      // semantics — same caveat applies (a concurrent writer between
      // get and put may race). For a casAtomic primary, pair with D1.
      if (expectedVersion !== undefined) {
        const existing = await bucket.get(key)
        if (existing) {
          const got = JSON.parse(await existing.text()) as EncryptedEnvelope
          if (got._v !== expectedVersion) {
            throw new ConflictError(
              got._v,
              `Version mismatch on ${vault}/${collection}/${id}: expected ${expectedVersion}, found ${got._v}`,
            )
          }
        } else if (expectedVersion !== 0) {
          throw new ConflictError(
            0,
            `Record ${vault}/${collection}/${id} does not exist (expected v=${expectedVersion})`,
          )
        }
      }
      await bucket.put(key, JSON.stringify(envelope))
    },

    async delete(vault, collection, id): Promise<void> {
      await bucket.delete(objectKey(vault, collection, id))
    },

    async list(vault, collection): Promise<string[]> {
      const out: string[] = []
      const pfx = collPrefix(vault, collection)
      let cursor: string | undefined
      do {
        const opts: R2ListOptions = { prefix: pfx }
        if (cursor !== undefined) opts.cursor = cursor
        const page = await bucket.list(opts)
        for (const obj of page.objects) {
          // Strip prefix + '.json' suffix to recover the id.
          const rest = obj.key.slice(pfx.length)
          if (rest.endsWith('.json')) {
            out.push(rest.slice(0, -'.json'.length))
          }
        }
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return out
    },

    async loadAll(vault): Promise<VaultSnapshot> {
      const snapshot: VaultSnapshot = {}
      const pfx = vaultPrefix(vault)
      let cursor: string | undefined
      do {
        const opts: R2ListOptions = { prefix: pfx }
        if (cursor !== undefined) opts.cursor = cursor
        const page = await bucket.list(opts)
        for (const obj of page.objects) {
          const rest = obj.key.slice(pfx.length)
          // rest = "{collection}/{id}.json"
          const slash = rest.indexOf('/')
          if (slash < 0 || !rest.endsWith('.json')) continue
          const collection = rest.slice(0, slash)
          const id = rest.slice(slash + 1, -'.json'.length)
          const got = await bucket.get(obj.key)
          if (!got) continue
          const env = JSON.parse(await got.text()) as EncryptedEnvelope
          if (!snapshot[collection]) snapshot[collection] = {}
          snapshot[collection]![id] = env
        }
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return snapshot
    },

    async saveAll(vault, data): Promise<void> {
      // Same shape as to-aws-s3.saveAll — drop everything under the
      // vault prefix, then write the new snapshot. Best-effort delete;
      // any new write that happens during this window is lost.
      const pfx = vaultPrefix(vault)
      let cursor: string | undefined
      const toDelete: string[] = []
      do {
        const opts: R2ListOptions = { prefix: pfx }
        if (cursor !== undefined) opts.cursor = cursor
        const page = await bucket.list(opts)
        for (const obj of page.objects) toDelete.push(obj.key)
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      if (toDelete.length > 0) {
        await bucket.delete(toDelete)
      }
      for (const [collection, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records ?? {})) {
          await bucket.put(objectKey(vault, collection, id), JSON.stringify(envelope))
        }
      }
    },
  }
}
