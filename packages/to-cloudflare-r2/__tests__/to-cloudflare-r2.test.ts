import { describe, expect, it } from 'vitest'
import type { S3Client } from '@aws-sdk/client-s3'
import { ConflictError } from '@noy-db/hub'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { r2, r2EndpointFor } from '../src/index.js'

function mockClient(handlers: Record<string, (input: unknown) => unknown>): {
  client: S3Client
  sent: Array<{ name: string; input: unknown }>
} {
  const sent: Array<{ name: string; input: unknown }> = []
  const client = {
    async send(command: unknown) {
      const name = (command as { constructor?: { name?: string } }).constructor?.name ?? 'Unknown'
      const input = (command as { input?: unknown }).input
      sent.push({ name, input })
      const handler = handlers[name]
      if (!handler) throw new Error(`Mock client got unexpected command: ${name}`)
      return handler(input)
    },
  } as unknown as S3Client
  return { client, sent }
}

describe('@noy-db/to-cloudflare-r2', () => {
  it('r2EndpointFor builds the canonical account URL', () => {
    expect(r2EndpointFor('abc123')).toBe('https://abc123.r2.cloudflarestorage.com')
  })

  it('requires accountId when no client is supplied', () => {
    expect(() =>
      r2({ bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }),
    ).toThrow(/client.*accountId/i)
  })

  it('requires credentials when accountId is supplied without a client', () => {
    expect(() => r2({ accountId: 'acc', bucket: 'b' })).toThrow(/accessKeyId.*secretAccessKey/)
  })

  it('accepts a pre-built client and exposes store.name = "cloudflare-r2"', () => {
    const { client } = mockClient({})
    const store = r2({ bucket: 'b', client })
    // Both construction paths (pre-built client and credentials) now wrap
    // s3() with r2's own identity + capabilities block, so the store always
    // reports name "cloudflare-r2" — no longer leaking the underlying "s3".
    expect(store.name).toBe('cloudflare-r2')
  })

  it('name is "cloudflare-r2" when constructed with credentials', () => {
    const store = r2({
      accountId: 'acc',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
    })
    expect(store.name).toBe('cloudflare-r2')
  })

  it('forwards get / put / delete to the injected S3Client', async () => {
    const { client, sent } = mockClient({
      PutObjectCommand: () => ({}),
      GetObjectCommand: () => ({
        Body: { async transformToString() { return JSON.stringify({ _noydb: 1, _v: 1, _ts: 't', _iv: 'a', _data: 'd' }) } },
      }),
      DeleteObjectCommand: () => ({}),
    })
    const store = r2({ bucket: 'b', client })
    await store.put('v1', 'c1', 'r1', { _noydb: 1, _v: 1, _ts: 't', _iv: 'a', _data: 'd' })
    await store.get('v1', 'c1', 'r1')
    await store.delete('v1', 'c1', 'r1')
    expect(sent.map(c => c.name)).toEqual(['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand'])
  })
})

// R2 inherits the CAS `put` from `s3()` via `...s3(opts)`. The full CAS
// branch matrix is covered in @noy-db/to-aws-s3's cas.test.ts; here we
// just prove R2 declares the capability and reaches the conditional-write
// path (IfNoneMatch '*' → 412 → ConflictError) through `r2()`.
describe('@noy-db/to-cloudflare-r2 CAS', () => {
  const env = (v: number): EncryptedEnvelope => ({ _noydb: 1, _v: v, _ts: 't', _iv: 'a', _data: `d${v}` })

  it('declares casAtomic: true', () => {
    const { client } = mockClient({})
    const store = r2({ bucket: 'b', client })
    expect(store.capabilities?.casAtomic).toBe(true)
  })

  it('create-only conflict surfaces as ConflictError through r2()', async () => {
    let exists = false
    const { client } = mockClient({
      PutObjectCommand: (input) => {
        const ifNoneMatch = (input as { IfNoneMatch?: string }).IfNoneMatch
        if (ifNoneMatch === '*' && exists) {
          const e = new Error('PreconditionFailed')
          e.name = 'PreconditionFailed'
          ;(e as { $metadata?: unknown }).$metadata = { httpStatusCode: 412 }
          throw e
        }
        exists = true
        return { ETag: '"e1"' }
      },
      GetObjectCommand: () => ({ ETag: '"e1"', Body: { async transformToString() { return JSON.stringify(env(1)) } } }),
    })
    const store = r2({ bucket: 'b', client })
    await store.put('v', 'c', 'id', env(1), 0)
    await expect(store.put('v', 'c', 'id', env(1), 0)).rejects.toBeInstanceOf(ConflictError)
  })
})
