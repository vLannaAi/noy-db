/**
 * Cloud-free tests for @noy-db/as-aws-s3.
 *
 * Command wiring is verified with a FAKE S3 client that captures commands (no
 * network). Presigned-URL generation is verified with a REAL S3Client + dummy
 * static credentials — SigV4 presigning is local crypto, so it runs offline.
 * No AWS credentials and no live calls are used.
 */
import { describe, it, expect } from 'vitest'
import { S3Client } from '@aws-sdk/client-s3'
import { asAwsS3 } from '../src/index.js'

function fakeClient(handlers: Record<string, (input: Record<string, unknown>) => unknown>) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = []
  const client = {
    sent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: async (cmd: any) => {
      const name = cmd.constructor.name
      sent.push({ name, input: cmd.input })
      const h = handlers[name]
      return h ? h(cmd.input) : {}
    },
  }
  return client
}

describe('as-aws-s3 — command wiring (fake client)', () => {
  it('putObject writes raw bytes with content type; public sets ACL; userMeta maps', async () => {
    const fc = fakeClient({})
    const obj = asAwsS3({ bucket: 'b', prefix: 'p', client: fc as unknown as S3Client })

    await obj.putObject('k.png', new Uint8Array([1, 2, 3]), { contentType: 'image/png', public: true, userMeta: { backlink: 'tok' } })

    const put = fc.sent.find((c) => c.name === 'PutObjectCommand')!
    expect(put.input.Bucket).toBe('b')
    expect(put.input.Key).toBe('p/k.png')
    expect(put.input.ContentType).toBe('image/png')
    expect(put.input.ACL).toBe('public-read')
    expect(put.input.Metadata).toEqual({ backlink: 'tok' })
  })

  it('private putObject omits ACL', async () => {
    const fc = fakeClient({})
    const obj = asAwsS3({ bucket: 'b', client: fc as unknown as S3Client })
    await obj.putObject('k', new Uint8Array([1]), { contentType: 'text/plain' })
    const put = fc.sent.find((c) => c.name === 'PutObjectCommand')!
    expect(put.input.ACL).toBeUndefined()
    expect(put.input.Key).toBe('k')
  })

  it('getObject returns bytes; NotFound → null', async () => {
    const bytes = new Uint8Array([7, 8, 9])
    const ok = asAwsS3({ bucket: 'b', client: fakeClient({ GetObjectCommand: () => ({ Body: { transformToByteArray: async () => bytes } }) }) as unknown as S3Client })
    expect(Buffer.from((await ok.getObject('k'))!).equals(Buffer.from(bytes))).toBe(true)

    const missing = asAwsS3({ bucket: 'b', client: fakeClient({ GetObjectCommand: () => { throw { name: 'NoSuchKey' } } }) as unknown as S3Client })
    expect(await missing.getObject('k')).toBeNull()
  })

  it('headObject maps S3 metadata; NotFound → null', async () => {
    const obj = asAwsS3({ bucket: 'b', client: fakeClient({
      HeadObjectCommand: () => ({ ContentLength: 42, ContentType: 'video/mp4', ETag: '"abc"', LastModified: new Date('2026-06-15T00:00:00Z'), Metadata: { dur: '12' } }),
    }) as unknown as S3Client })
    expect(await obj.headObject('k')).toEqual({ size: 42, contentType: 'video/mp4', etag: '"abc"', lastModified: '2026-06-15T00:00:00.000Z', userMeta: { dur: '12' } })

    const missing = asAwsS3({ bucket: 'b', client: fakeClient({ HeadObjectCommand: () => { throw { $metadata: { httpStatusCode: 404 } } } }) as unknown as S3Client })
    expect(await missing.headObject('k')).toBeNull()
  })

  it('deleteObject sends a delete', async () => {
    const fc = fakeClient({})
    await asAwsS3({ bucket: 'b', client: fc as unknown as S3Client }).deleteObject('k')
    expect(fc.sent.some((c) => c.name === 'DeleteObjectCommand')).toBe(true)
  })

  it('listPrefix lists objects and strips the configured prefix', async () => {
    const fc = fakeClient({
      ListObjectsV2Command: () => ({
        Contents: [
          { Key: 'p/a/b.png', Size: 10, ETag: '"e1"' },
          { Key: 'p/a/c.png', Size: 20, ETag: '"e2"', LastModified: new Date('2026-06-15T00:00:00Z') },
        ],
        IsTruncated: false,
      }),
    })
    const obj = asAwsS3({ bucket: 'b', prefix: 'p', client: fc as unknown as S3Client })
    const list = await obj.listPrefix('a/')
    expect(list).toEqual([
      { key: 'a/b.png', meta: { size: 10, etag: '"e1"' } },
      { key: 'a/c.png', meta: { size: 20, etag: '"e2"', lastModified: '2026-06-15T00:00:00.000Z' } },
    ])
    // queried under the full prefix
    const cmd = fc.sent.find((c) => c.name === 'ListObjectsV2Command')!
    expect(cmd.input.Prefix).toBe('p/a/')
  })

  it('publicUrl is a stable URL honoring baseUrl + prefix', () => {
    const obj = asAwsS3({ bucket: 'b', prefix: 'assets', baseUrl: 'https://cdn.example.com', client: fakeClient({}) as unknown as S3Client })
    expect(obj.publicUrl('logo.png')).toBe('https://cdn.example.com/assets/logo.png')
  })
})

describe('as-aws-s3 — presigned URLs (real client, dummy creds, offline)', () => {
  const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'examplesecretkey' } })

  it('objectUrl produces a presigned GET carrying the key + expiry', async () => {
    const obj = asAwsS3({ bucket: 'b', prefix: 'p', region: 'us-east-1', client })
    const url = await obj.objectUrl('k.png', { expiresInSeconds: 120 })
    expect(url).toContain('p/k.png')
    expect(url).toContain('X-Amz-Signature=')
    expect(url).toContain('X-Amz-Expires=120')
  })

  it('putUrl produces a presigned PUT', async () => {
    const obj = asAwsS3({ bucket: 'b', region: 'us-east-1', client })
    const url = await obj.putUrl('big.mp4', { contentType: 'video/mp4', expiresInSeconds: 300 })
    expect(url).toContain('big.mp4')
    expect(url).toContain('X-Amz-Signature=')
    expect(url).toContain('X-Amz-Expires=300')
  })
})
