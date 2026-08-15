/**
 * The real {@link VaultHeadStrategy} (#1044).
 *
 * @packageDocumentation
 */
import type { NoydbStore } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import {
  DEFAULT_HEAD_BUCKETS,
  VAULT_HEAD_COLLECTION,
  type HeadEntry,
  type VaultHeadStrategy,
  type WithVaultHeadOptions,
} from './strategy.js'
import { bucketId, readBucket, writeBucket } from './head.js'

export function withVaultHead(opts: WithVaultHeadOptions = {}): VaultHeadStrategy {
  const buckets = opts.buckets ?? DEFAULT_HEAD_BUCKETS

  const dekFor = (getDEK: (c: string) => Promise<EnclaveKey>) => getDEK(VAULT_HEAD_COLLECTION)

  return {
    enabled: true,
    bucketFor: (collection, id) => bucketId(collection, id, buckets),

    async note(store: NoydbStore, vault, getDEK, entry: HeadEntry) {
      const dek = await dekFor(getDEK)
      const bucket = bucketId(entry.collection, entry.id, buckets)
      const { body, version } = await readBucket(store, vault, dek, bucket)
      const key = `${entry.collection}/${entry.id}`
      // Monotonic: a head entry never moves BACKWARD. A write that would lower
      // it is either a stale retry or a rollback being laundered through the
      // client's own head, and neither should be recorded.
      if ((body[key] ?? -1) >= entry.version) return
      body[key] = entry.version
      await writeBucket(store, vault, dek, bucket, body, version)
    },

    async expected(store, vault, getDEK, collection, id) {
      const dek = await dekFor(getDEK)
      const { body } = await readBucket(store, vault, dek, bucketId(collection, id, buckets))
      return body[`${collection}/${id}`] ?? null
    },

    async knownIn(store, vault, getDEK, collection) {
      const dek = await dekFor(getDEK)
      const out = new Map<string, number>()
      const prefix = `${collection}/`
      // Sweep every bucket: a record's bucket is a function of its id, so the
      // set for one collection is spread across all of them.
      for (const bucket of await store.list(vault, VAULT_HEAD_COLLECTION)) {
        if (!bucket.startsWith(`${collection}::`)) continue
        const { body } = await readBucket(store, vault, dek, bucket)
        for (const [k, v] of Object.entries(body)) {
          if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v)
        }
      }
      return out
    },
  }
}
