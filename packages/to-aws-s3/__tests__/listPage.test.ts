import { describe, it, expect } from 'vitest'
import type { S3Client } from '@aws-sdk/client-s3'
import { s3 } from '../src/index.js'

/**
 * Mock S3Client. Captures every command sent and returns canned responses
 * keyed by the command's class name. The s3 adapter accepts an injected
 * S3Client via `options.client`, so we don't need to vi.mock the AWS SDK.
 *
 * S3 GetObject responses use a `Body` with a `transformToString()` method,
 * so we wrap the canned body string in a small adapter object.
 */
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

function bodyOf(json: unknown): { transformToString: () => Promise<string> } {
  return {
    async transformToString() {
      return JSON.stringify(json)
    },
  }
}

describe('@noy-db/store-aws-s3 — listPage', () => {
  it('1. has a name field for diagnostic logging', () => {
    const { client } = mockClient({})
    const adapter = s3({ bucket: 'b', client })
    expect(adapter.name).toBe('s3')
  })

  it('2. exposes listPage as an optional method', () => {
    const { client } = mockClient({})
    const adapter = s3({ bucket: 'b', client })
    expect(typeof adapter.listPage).toBe('function')
  })

  it('3. forwards limit to ListObjectsV2Command.MaxKeys', async () => {
    const { client, sent } = mockClient({
      ListObjectsV2Command: () => ({ Contents: [], IsTruncated: false }),
    })
    const adapter = s3({ bucket: 'noydb-prod', client })
    await adapter.listPage!('C1', 'invoices', undefined, 25)

    const listCall = sent.find(c => c.name === 'ListObjectsV2Command')
    expect(listCall).toBeTruthy()
    const input = listCall!.input as { MaxKeys?: number }
    expect(input.MaxKeys).toBe(25)
  })

  it('4. forwards cursor to ListObjectsV2Command.ContinuationToken', async () => {
    const { client, sent } = mockClient({
      ListObjectsV2Command: () => ({ Contents: [], IsTruncated: false }),
    })
    const adapter = s3({ bucket: 'b', client })
    await adapter.listPage!('C1', 'invoices', 'opaque-continuation-token-from-s3', 10)

    const input = sent[0]!.input as { ContinuationToken?: string }
    expect(input.ContinuationToken).toBe('opaque-continuation-token-from-s3')
  })

  it('5. fetches each listed object and returns parsed envelopes', async () => {
    const env1 = { _noydb: 1, _v: 1, _ts: 'ts1', _iv: 'iv1', _data: 'data1' }
    const env2 = { _noydb: 1, _v: 2, _ts: 'ts2', _iv: 'iv2', _data: 'data2' }

    const { client } = mockClient({
      ListObjectsV2Command: () => ({
        Contents: [
          { Key: 'C1/invoices/inv-001.json' },
          { Key: 'C1/invoices/inv-002.json' },
        ],
        IsTruncated: false,
      }),
      GetObjectCommand: (input: unknown) => {
        const key = (input as { Key: string }).Key
        return {
          Body: bodyOf(key.endsWith('inv-001.json') ? env1 : env2),
        }
      },
    })

    const adapter = s3({ bucket: 'b', client })
    const page = await adapter.listPage!('C1', 'invoices', undefined, 10)

    expect(page.items).toHaveLength(2)
    expect(page.items[0]).toEqual({ id: 'inv-001', envelope: env1 })
    expect(page.items[1]).toEqual({ id: 'inv-002', envelope: env2 })
  })

  it('6. returns the next ContinuationToken as the cursor when truncated', async () => {
    const { client } = mockClient({
      ListObjectsV2Command: () => ({
        Contents: [],
        IsTruncated: true,
        NextContinuationToken: 'next-page-token',
      }),
    })
    const adapter = s3({ bucket: 'b', client })
    const page = await adapter.listPage!('C1', 'invoices', undefined, 10)
    expect(page.nextCursor).toBe('next-page-token')
  })

  it('7. returns nextCursor: null when not truncated (final page)', async () => {
    const { client } = mockClient({
      ListObjectsV2Command: () => ({ Contents: [], IsTruncated: false }),
    })
    const adapter = s3({ bucket: 'b', client })
    const page = await adapter.listPage!('C1', 'invoices', undefined, 10)
    expect(page.nextCursor).toBeNull()
  })

  it('8. returns nextCursor: null when truncated but no NextContinuationToken (defensive)', async () => {
    const { client } = mockClient({
      ListObjectsV2Command: () => ({ Contents: [], IsTruncated: true }),
    })
    const adapter = s3({ bucket: 'b', client })
    const page = await adapter.listPage!('C1', 'invoices', undefined, 10)
    expect(page.nextCursor).toBeNull()
  })

  it('9. respects the prefix option in object keys', async () => {
    const { client, sent } = mockClient({
      ListObjectsV2Command: () => ({ Contents: [], IsTruncated: false }),
    })
    const adapter = s3({ bucket: 'b', prefix: 'app1', client })
    await adapter.listPage!('C1', 'invoices')

    const input = sent[0]!.input as { Prefix?: string }
    expect(input.Prefix).toBe('app1/C1/invoices/')
  })
})
