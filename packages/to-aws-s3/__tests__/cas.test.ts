/**
 * CAS (compare-and-swap) unit tests for the `casAtomic: true` capability.
 *
 * `to-aws-s3` (and `to-cloudflare-r2`, which inherits this `put` via
 * `...s3(opts)`) implement atomic CAS on top of S3 conditional writes:
 *   - create-only  → `PutObject` with `IfNoneMatch: '*'`
 *   - update       → `GetObject` (read `_v` + ETag) then `PutObject` with
 *                    `IfMatch: <etag>`
 *   - a 412 PreconditionFailed on either path becomes a `ConflictError`.
 *
 * These tests exercise every CAS branch against a fake S3 that faithfully
 * models `IfNoneMatch`/`IfMatch`/412 semantics — including a concurrent
 * writer slipping in between the store's internal Get and Put (the case
 * that proves the final `IfMatch` guard, not just the read-check, is what
 * makes the swap atomic). The real-service equivalent ran against live
 * S3 + R2 during the pre.14 release; this is the permanent regression net.
 */
import { describe, it, expect } from 'vitest'
import type { S3Client } from '@aws-sdk/client-s3'
import { ConflictError } from '@noy-db/hub'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { s3 } from '../src/index.js'

interface Hooks {
  /** Fired after each GetObjectCommand is served, with the object key. Lets a
   *  test inject a concurrent write between the store's internal Get and Put. */
  afterGet?: (key: string) => void
}

/** Fake S3 modelling IfNoneMatch / IfMatch / 412 + string bodies. */
function fakeS3(hooks: Hooks = {}): { client: S3Client; objects: Map<string, { body: string; etag: string }> } {
  const objects = new Map<string, { body: string; etag: string }>()
  let etagSeq = 0
  const precondition = () => {
    const e = new Error('PreconditionFailed')
    e.name = 'PreconditionFailed'
    ;(e as { $metadata?: unknown }).$metadata = { httpStatusCode: 412 }
    return e
  }
  const client = {
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name
      const input = (command as { input: Record<string, unknown> }).input
      const key = input.Key as string
      if (name === 'GetObjectCommand') {
        const obj = objects.get(key)
        if (!obj) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e }
        // Snapshot the ETag NOW — a concurrent write injected via afterGet
        // must not retroactively change what this caller already read.
        const snapshot = { ETag: `"${obj.etag}"`, Body: { async transformToString() { return obj.body } } }
        hooks.afterGet?.(key)
        return snapshot
      }
      if (name === 'PutObjectCommand') {
        const current = objects.get(key)
        const ifNoneMatch = input.IfNoneMatch as string | undefined
        const ifMatch = input.IfMatch as string | undefined
        if (ifNoneMatch === '*' && current) throw precondition()
        if (ifMatch !== undefined && (!current || `"${current.etag}"` !== ifMatch)) throw precondition()
        const etag = `e${++etagSeq}`
        objects.set(key, { body: input.Body as string, etag })
        return { ETag: `"${etag}"` }
      }
      if (name === 'DeleteObjectCommand') { objects.delete(key); return {} }
      throw new Error(`unexpected command ${name}`)
    },
  } as unknown as S3Client
  return { client, objects }
}

function env(v: number): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(), _iv: 'aaaaaaaaaaaaaaaa', _data: `ct-${v}`, _by: 'alice' }
}

describe('to-aws-s3 CAS (casAtomic)', () => {
  it('declares casAtomic: true', () => {
    const { client } = fakeS3()
    const store = s3({ bucket: 'b', client })
    expect(store.capabilities?.casAtomic).toBe(true)
  })

  it('create-only (expectedVersion 0): first write succeeds, second throws ConflictError', async () => {
    const { client, objects } = fakeS3()
    const store = s3({ bucket: 'b', client })
    await store.put('v', 'c', 'id', env(1), 0)
    expect(objects.size).toBe(1)
    await expect(store.put('v', 'c', 'id', env(1), 0)).rejects.toBeInstanceOf(ConflictError)
  })

  it('update: matching expectedVersion succeeds and bumps the stored version', async () => {
    const { client } = fakeS3()
    const store = s3({ bucket: 'b', client })
    await store.put('v', 'c', 'id', env(1), 0)
    await store.put('v', 'c', 'id', env(2), 1)
    expect((await store.get('v', 'c', 'id'))?._v).toBe(2)
  })

  it('update: stale expectedVersion throws ConflictError without writing', async () => {
    const { client } = fakeS3()
    const store = s3({ bucket: 'b', client })
    await store.put('v', 'c', 'id', env(1), 0)
    await store.put('v', 'c', 'id', env(2), 1) // now at v=2
    await expect(store.put('v', 'c', 'id', env(3), 1)).rejects.toBeInstanceOf(ConflictError)
    expect((await store.get('v', 'c', 'id'))?._v).toBe(2) // unchanged
  })

  it('update: missing key throws ConflictError', async () => {
    const { client } = fakeS3()
    const store = s3({ bucket: 'b', client })
    await expect(store.put('v', 'c', 'ghost', env(2), 1)).rejects.toBeInstanceOf(ConflictError)
  })

  it('update: a concurrent writer between Get and Put trips the IfMatch guard → ConflictError', async () => {
    const hooks: Hooks = {}
    const { client, objects } = fakeS3(hooks)
    const store = s3({ bucket: 'b', client })
    await store.put('v', 'c', 'id', env(1), 0)
    // Inject exactly one concurrent write the next time the store reads this
    // key: bump the stored ETag so the IfMatch the store captured is stale.
    hooks.afterGet = (key) => {
      const o = objects.get(key)!
      objects.set(key, { body: o.body, etag: `${o.etag}-concurrent` })
      hooks.afterGet = undefined
    }
    await expect(store.put('v', 'c', 'id', env(2), 1)).rejects.toBeInstanceOf(ConflictError)
  })

  it('unconditional put (no expectedVersion) overwrites', async () => {
    const { client } = fakeS3()
    const store = s3({ bucket: 'b', client })
    await store.put('v', 'c', 'id', env(1))
    await store.put('v', 'c', 'id', env(9))
    expect((await store.get('v', 'c', 'id'))?._v).toBe(9)
  })
})
