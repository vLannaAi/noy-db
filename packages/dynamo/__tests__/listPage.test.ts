import { describe, it, expect } from 'vitest'
import { dynamo, type DynamoDocClient } from '../src/index.js'

/**
 * Mock DynamoDB document client. Captures every command sent and returns
 * canned responses keyed by the command's class name. The real adapter
 * imports `@aws-sdk/lib-dynamodb` lazily, so we plug a fake client through
 * the `client` option which short-circuits the dynamic import.
 */
function mockClient(handlers: Record<string, (input: unknown) => unknown>): {
  client: DynamoDocClient
  sent: Array<{ name: string; input: unknown }>
} {
  const sent: Array<{ name: string; input: unknown }> = []
  const client: DynamoDocClient = {
    async send(command: unknown) {
      const name = (command as { constructor?: { name?: string } }).constructor?.name ?? 'Unknown'
      const input = (command as { input?: unknown }).input
      sent.push({ name, input })
      const handler = handlers[name]
      if (!handler) throw new Error(`Mock client got unexpected command: ${name}`)
      return handler(input)
    },
  }
  return { client, sent }
}

describe('@noy-db/dynamo — listPage', () => {
  it('1. has a name field for diagnostic logging', () => {
    const { client } = mockClient({})
    const adapter = dynamo({ table: 't', client })
    expect(adapter.name).toBe('dynamo')
  })

  it('2. exposes listPage as an optional method', () => {
    const { client } = mockClient({})
    const adapter = dynamo({ table: 't', client })
    expect(typeof adapter.listPage).toBe('function')
  })

  it('3. forwards limit to QueryCommand.Limit', async () => {
    const { client, sent } = mockClient({
      QueryCommand: () => ({ Items: [], LastEvaluatedKey: undefined }),
    })
    const adapter = dynamo({ table: 'noydb-prod', client })
    await adapter.listPage!('C1', 'invoices', undefined, 25)

    expect(sent).toHaveLength(1)
    const input = sent[0]!.input as { Limit?: number }
    expect(input.Limit).toBe(25)
  })

  it('4. uses ExclusiveStartKey from base64-decoded cursor', async () => {
    const lastKey = { pk: 'C1', sk: 'invoices#inv-099' }
    const cursor = btoa(unescape(encodeURIComponent(JSON.stringify(lastKey))))

    const { client, sent } = mockClient({
      QueryCommand: () => ({ Items: [], LastEvaluatedKey: undefined }),
    })
    const adapter = dynamo({ table: 't', client })
    await adapter.listPage!('C1', 'invoices', cursor, 10)

    const input = sent[0]!.input as { ExclusiveStartKey?: Record<string, unknown> }
    expect(input.ExclusiveStartKey).toEqual(lastKey)
  })

  it('5. converts items to envelopes and parses ids from sort keys', async () => {
    const { client } = mockClient({
      QueryCommand: () => ({
        Items: [
          { pk: 'C1', sk: 'invoices#inv-001', _noydb: 1, _v: 1, _ts: '2026-04-06T00:00:00Z', _iv: 'iv1', _data: 'data1' },
          { pk: 'C1', sk: 'invoices#inv-002', _noydb: 1, _v: 2, _ts: '2026-04-06T00:00:01Z', _iv: 'iv2', _data: 'data2' },
        ],
        LastEvaluatedKey: undefined,
      }),
    })
    const adapter = dynamo({ table: 't', client })
    const page = await adapter.listPage!('C1', 'invoices', undefined, 10)

    expect(page.items).toHaveLength(2)
    expect(page.items[0]).toEqual({
      id: 'inv-001',
      envelope: { _noydb: 1, _v: 1, _ts: '2026-04-06T00:00:00Z', _iv: 'iv1', _data: 'data1' },
    })
    expect(page.items[1]?.id).toBe('inv-002')
  })

  it('6. encodes LastEvaluatedKey as base64 cursor for the next page', async () => {
    const lastKey = { pk: 'C1', sk: 'invoices#inv-099' }
    const { client } = mockClient({
      QueryCommand: () => ({ Items: [], LastEvaluatedKey: lastKey }),
    })
    const adapter = dynamo({ table: 't', client })
    const page = await adapter.listPage!('C1', 'invoices', undefined, 10)

    expect(page.nextCursor).not.toBeNull()
    const decoded = JSON.parse(decodeURIComponent(escape(atob(page.nextCursor!)))) as Record<string, unknown>
    expect(decoded).toEqual(lastKey)
  })

  it('7. returns nextCursor: null when LastEvaluatedKey is missing (final page)', async () => {
    const { client } = mockClient({
      QueryCommand: () => ({ Items: [], LastEvaluatedKey: undefined }),
    })
    const adapter = dynamo({ table: 't', client })
    const page = await adapter.listPage!('C1', 'invoices', undefined, 10)
    expect(page.nextCursor).toBeNull()
  })

  it('8. cursor round-trip: encoded cursor decodes back to original key', async () => {
    const { client, sent } = mockClient({
      QueryCommand: () => ({
        Items: [],
        LastEvaluatedKey: { pk: 'C1', sk: 'invoices#inv-099' },
      }),
    })
    const adapter = dynamo({ table: 't', client })

    const page1 = await adapter.listPage!('C1', 'invoices')
    expect(page1.nextCursor).not.toBeNull()

    // Use the cursor for a second call.
    await adapter.listPage!('C1', 'invoices', page1.nextCursor!)
    const secondInput = sent[1]!.input as { ExclusiveStartKey?: Record<string, unknown> }
    expect(secondInput.ExclusiveStartKey).toEqual({ pk: 'C1', sk: 'invoices#inv-099' })
  })
})
