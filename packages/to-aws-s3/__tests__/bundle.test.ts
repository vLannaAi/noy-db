import { describe, it, expect } from 'vitest'
import type { S3Client } from '@aws-sdk/client-s3'
import { BundleVersionConflictError } from '@noy-db/hub'
import { s3Bundle } from '../src/bundle.js'

/** In-memory fake S3 with ETag + IfMatch semantics. */
function fakeS3(): { client: S3Client; objects: Map<string, { body: Uint8Array; etag: string }> } {
  const objects = new Map<string, { body: Uint8Array; etag: string }>()
  let etagSeq = 0
  const client = {
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name
      const input = (command as { input: Record<string, unknown> }).input
      const key = input.Key as string
      if (name === 'GetObjectCommand') {
        const obj = objects.get(key)
        if (!obj) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e }
        return { ETag: `"${obj.etag}"`, Body: { async transformToByteArray() { return obj.body } } }
      }
      if (name === 'PutObjectCommand') {
        const current = objects.get(key)
        const ifMatch = input.IfMatch as string | undefined
        if (ifMatch !== undefined && (!current || current.etag !== ifMatch)) {
          const e = new Error('PreconditionFailed'); e.name = 'PreconditionFailed'
          ;(e as { $metadata?: unknown }).$metadata = { httpStatusCode: 412 }
          throw e
        }
        const etag = `etag-${++etagSeq}`
        objects.set(key, { body: input.Body as Uint8Array, etag })
        return { ETag: `"${etag}"` }
      }
      if (name === 'DeleteObjectCommand') { objects.delete(key); return {} }
      if (name === 'ListObjectsV2Command') {
        const pfx = (input.Prefix as string) ?? ''
        const contents = [...objects.entries()]
          .filter(([k]) => k.startsWith(pfx))
          .map(([k, v]) => ({ Key: k, ETag: `"${v.etag}"`, Size: v.body.length }))
        return { Contents: contents, IsTruncated: false }
      }
      throw new Error(`unexpected command ${name}`)
    },
  } as unknown as S3Client
  return { client, objects }
}

const bytes = (s: string) => new TextEncoder().encode(s)

describe('s3Bundle', () => {
  it('has kind "bundle" and name "s3"', () => {
    const { client } = fakeS3()
    const store = s3Bundle({ bucket: 'b', client })
    expect(store.kind).toBe('bundle')
    expect(store.name).toBe('s3')
  })

  it('round-trips write then read with the .noydb key scheme', async () => {
    const { client, objects } = fakeS3()
    const store = s3Bundle({ bucket: 'b', prefix: 'snaps', client })
    const w = await store.writeBundle('v1__snap_000001', bytes('hello'), null)
    expect(w.version).toBeTruthy()
    expect([...objects.keys()]).toEqual(['snaps/v1__snap_000001.noydb'])
    const r = await store.readBundle('v1__snap_000001')
    expect(new TextDecoder().decode(r!.bytes)).toBe('hello')
    expect(r!.version).toBe(w.version)
  })

  it('readBundle returns null for a missing key', async () => {
    const { client } = fakeS3()
    const store = s3Bundle({ bucket: 'b', client })
    expect(await store.readBundle('nope')).toBeNull()
  })

  it('null expectedVersion overwrites unconditionally (rolling auto key)', async () => {
    const { client } = fakeS3()
    const store = s3Bundle({ bucket: 'b', client })
    await store.writeBundle('v__auto', bytes('one'), null)
    await store.writeBundle('v__auto', bytes('two'), null)
    const r = await store.readBundle('v__auto')
    expect(new TextDecoder().decode(r!.bytes)).toBe('two')
  })

  it('IfMatch on a stale version throws BundleVersionConflictError', async () => {
    const { client } = fakeS3()
    const store = s3Bundle({ bucket: 'b', client })
    const w1 = await store.writeBundle('k', bytes('a'), null)
    await store.writeBundle('k', bytes('b'), null) // advances the ETag
    await expect(store.writeBundle('k', bytes('c'), w1.version)).rejects.toThrow(BundleVersionConflictError)
  })

  it('IfMatch on the current version succeeds', async () => {
    const { client } = fakeS3()
    const store = s3Bundle({ bucket: 'b', client })
    const w1 = await store.writeBundle('k', bytes('a'), null)
    const w2 = await store.writeBundle('k', bytes('b'), w1.version)
    expect(w2.version).not.toBe(w1.version)
  })

  it('listBundles derives vaultId/version/size with no GetObject', async () => {
    const { client } = fakeS3()
    const store = s3Bundle({ bucket: 'b', prefix: 'p', client })
    await store.writeBundle('v1__index', bytes('idx'), null)
    await store.writeBundle('v1__snap_000001', bytes('snapshot-bytes'), null)
    const list = await store.listBundles()
    const ids = list.map(x => x.vaultId).sort()
    expect(ids).toEqual(['v1__index', 'v1__snap_000001'])
    const snap = list.find(x => x.vaultId === 'v1__snap_000001')!
    expect(snap.size).toBe(bytes('snapshot-bytes').length)
    expect(snap.version).toBeTruthy()
  })

  it('deleteBundle removes the object', async () => {
    const { client, objects } = fakeS3()
    const store = s3Bundle({ bucket: 'b', client })
    await store.writeBundle('k', bytes('a'), null)
    await store.deleteBundle('k')
    expect(objects.size).toBe(0)
  })
})
