/**
 * **@noy-db/to-aws-dynamo** — DynamoDB single-table store for NOYDB.
 *
 * Uses a single DynamoDB table with a composite key:
 * - **`pk`** (partition key, String) — vault name.
 * - **`sk`** (sort key, String) — `{collection}#{id}`.
 *
 * This layout keeps every record of a vault in one partition, making
 * `loadAll()` a single `Query` call with no scatter-gather. Individual
 * reads and writes use `GetItem` / `PutItem` with optional
 * `ConditionExpression` for atomic compare-and-swap.
 *
 * ## When to use
 *
 * - **Cloud-synced vaults** — DynamoDB's per-item CAS
 *   (`casAtomic: true`) is safe under concurrent writes from multiple
 *   clients (multi-user, multi-tab).
 * - **Serverless / Lambda** — no connection pool to manage; each
 *   invocation opens fresh HTTP connections via the AWS SDK.
 * - **Pair with S3 for blobs** — keep structured records in DynamoDB
 *   and route binary attachments to `@noy-db/to-aws-s3` via `routeStore`.
 *
 * ## IAM minimum permissions
 *
 * ```json
 * { "Action": ["dynamodb:GetItem", "dynamodb:PutItem",
 *              "dynamodb:DeleteItem", "dynamodb:Query"] }
 * ```
 *
 * ## Capabilities
 *
 * | Capability | Value |
 * |---|---|
 * | `casAtomic` | `true` — DynamoDB `ConditionExpression` on `_v` |
 * | `ping` | ✓ — `DescribeTable` |
 *
 * @packageDocumentation
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'

/**
 * Options for `dynamo()`.
 *
 * The adapter uses a single-table design with a composite primary key
 * `pk = {vault}` (partition) and `sk = {collection}#{id}` (sort). This keeps
 * all records for a vault in a single DynamoDB partition for efficient
 * `loadAll()` via a single Query. For DynamoDB Local development, set
 * `endpoint: 'http://localhost:8000'`.
 */
export interface DynamoOptions {
  /** DynamoDB table name. */
  table: string
  /** AWS region. Default: 'us-east-1'. */
  region?: string
  /** Custom endpoint (e.g., 'http://localhost:8000' for DynamoDB Local). */
  endpoint?: string
  /** DynamoDB document client instance (for advanced configuration). */
  client?: DynamoDocClient
}

/**
 * Minimal interface for DynamoDB document client operations.
 * Compatible with @aws-sdk/lib-dynamodb's DynamoDBDocumentClient.
 */
export interface DynamoDocClient {
  send(command: unknown): Promise<unknown>
}

// Command types matching @aws-sdk/lib-dynamodb
interface GetCommandInput { TableName: string; Key: Record<string, unknown> }
interface PutCommandInput { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> }
interface DeleteCommandInput { TableName: string; Key: Record<string, unknown> }
interface QueryCommandInput {
  TableName: string
  KeyConditionExpression: string
  ExpressionAttributeNames?: Record<string, string>
  ExpressionAttributeValues?: Record<string, unknown>
  Limit?: number
  ExclusiveStartKey?: Record<string, unknown>
}

/**
 * Create a DynamoDB adapter using single-table design.
 *
 * Table schema:
 * - pk (String, partition key): vault name
 * - sk (String, sort key): `{collection}#{id}` or `_keyring#{userId}` or `_sync#meta`
 * - _v (Number): record version
 * - _ts (String): timestamp
 * - _iv (String): base64 IV
 * - _data (String): base64 ciphertext
 */
export function dynamo(options: DynamoOptions): NoydbStore {
  const { table } = options

  // Lazy client initialization — only creates the client when first used
  let clientPromise: Promise<DynamoDocClient> | null = null

  async function getClient(): Promise<DynamoDocClient> {
    if (options.client) return options.client

    if (!clientPromise) {
      clientPromise = (async () => {
        // Dynamic import to keep @aws-sdk as a peer dep
        const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb') as { DynamoDBClient: new (config: Record<string, unknown>) => unknown }
        const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as { DynamoDBDocumentClient: { from: (client: unknown) => DynamoDocClient } }

        const config: Record<string, unknown> = {}
        if (options.region) config['region'] = options.region
        if (options.endpoint) config['endpoint'] = options.endpoint

        const ddbClient = new DynamoDBClient(config)
        return DynamoDBDocumentClient.from(ddbClient)
      })()
    }

    return clientPromise
  }

  function sk(collection: string, id: string): string {
    return `${collection}#${id}`
  }

  function parseSk(sortKey: string): { collection: string; id: string } {
    const idx = sortKey.indexOf('#')
    return {
      collection: sortKey.slice(0, idx),
      id: sortKey.slice(idx + 1),
    }
  }

  function itemToEnvelope(item: Record<string, unknown>): EncryptedEnvelope {
    return {
      _noydb: 1,
      _v: item['_v'] as number,
      _ts: item['_ts'] as string,
      _iv: item['_iv'] as string,
      _data: item['_data'] as string,
    }
  }

  return {
    name: 'dynamo',

    async get(vault, collection, id) {
      const client = await getClient()
      const { GetCommand } = await import('@aws-sdk/lib-dynamodb') as { GetCommand: new (input: GetCommandInput) => unknown }

      const result = await client.send(new GetCommand({
        TableName: table,
        Key: { pk: vault, sk: sk(collection, id) },
      })) as { Item?: Record<string, unknown> }

      if (!result.Item) return null
      return itemToEnvelope(result.Item)
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const client = await getClient()
      const { PutCommand } = await import('@aws-sdk/lib-dynamodb') as { PutCommand: new (input: PutCommandInput) => unknown }

      const item: Record<string, unknown> = {
        pk: vault,
        sk: sk(collection, id),
        _noydb: envelope._noydb,
        _v: envelope._v,
        _ts: envelope._ts,
        _iv: envelope._iv,
        _data: envelope._data,
      }

      const input: PutCommandInput = { TableName: table, Item: item }

      if (expectedVersion !== undefined) {
        input.ConditionExpression = '#v = :expected OR attribute_not_exists(pk)'
        input.ExpressionAttributeNames = { '#v': '_v' }
        input.ExpressionAttributeValues = { ':expected': expectedVersion }
      }

      try {
        await client.send(new PutCommand(input))
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
          // Fetch current version for error
          const current = await this.get(vault, collection, id)
          throw new ConflictError(
            current?._v ?? 0,
            `Version conflict: expected ${expectedVersion}, found ${current?._v}`,
          )
        }
        throw err
      }
    },

    async delete(vault, collection, id) {
      const client = await getClient()
      const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb') as { DeleteCommand: new (input: DeleteCommandInput) => unknown }

      await client.send(new DeleteCommand({
        TableName: table,
        Key: { pk: vault, sk: sk(collection, id) },
      }))
    },

    async list(vault, collection) {
      const client = await getClient()
      const { QueryCommand } = await import('@aws-sdk/lib-dynamodb') as { QueryCommand: new (input: QueryCommandInput) => unknown }

      const result = await client.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': vault,
          ':prefix': `${collection}#`,
        },
      })) as { Items?: Record<string, unknown>[] }

      return (result.Items ?? []).map(item => {
        const { id } = parseSk(item['sk'] as string)
        return id
      })
    },

    async loadAll(vault) {
      const client = await getClient()
      const { QueryCommand } = await import('@aws-sdk/lib-dynamodb') as { QueryCommand: new (input: QueryCommandInput) => unknown }

      const result = await client.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': vault },
      })) as { Items?: Record<string, unknown>[] }

      const snapshot: VaultSnapshot = {}

      for (const item of result.Items ?? []) {
        const sortKey = item['sk'] as string
        const { collection, id } = parseSk(sortKey)

        if (collection.startsWith('_')) continue // skip _keyring, _sync

        if (!snapshot[collection]) {
          snapshot[collection] = {}
        }
        snapshot[collection][id] = itemToEnvelope(item)
      }

      return snapshot
    },

    async saveAll(vault, data) {
      // Use individual puts (DynamoDB batch write has limitations with conditions)
      for (const [collName, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records)) {
          await this.put(vault, collName, id, envelope)
        }
      }
    },

    async ping() {
      try {
        const client = await getClient()
        const { QueryCommand } = await import('@aws-sdk/lib-dynamodb') as { QueryCommand: new (input: QueryCommandInput) => unknown }

        await client.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': '__ping__' },
        }))
        return true
      } catch {
        return false
      }
    },

    /**
     * Paginate over a collection using DynamoDB's native `LastEvaluatedKey`
     * cursor. The cursor is base64-encoded JSON of the LastEvaluatedKey
     * object so it round-trips through any caller transport.
     *
     * Each page is a single Query call against the partition key, so the
     * read cost is `pageSize ÷ 4 KB` RCUs (eventually consistent) per page.
     */
    async listPage(vault, collection, cursor, limit = 100) {
      const client = await getClient()
      const { QueryCommand } = await import('@aws-sdk/lib-dynamodb') as { QueryCommand: new (input: QueryCommandInput) => unknown }

      const input: QueryCommandInput = {
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': vault,
          ':prefix': `${collection}#`,
        },
        Limit: limit,
      }
      if (cursor) {
        input.ExclusiveStartKey = JSON.parse(b64decode(cursor)) as Record<string, unknown>
      }

      const result = await client.send(new QueryCommand(input)) as {
        Items?: Record<string, unknown>[]
        LastEvaluatedKey?: Record<string, unknown>
      }

      const items: Array<{ id: string; envelope: EncryptedEnvelope }> = []
      for (const item of result.Items ?? []) {
        const { id } = parseSk(item['sk'] as string)
        items.push({ id, envelope: itemToEnvelope(item) })
      }

      const nextCursor = result.LastEvaluatedKey
        ? b64encode(JSON.stringify(result.LastEvaluatedKey))
        : null

      return { items, nextCursor }
    },
  }
}

/**
 * Tiny base64 helpers that work in both Node 20+ and any modern browser
 * without pulling in @types/node or relying on a Buffer polyfill. The
 * dynamo adapter has zero non-AWS dependencies and we want to keep it
 * that way — listPage cursors are short JSON blobs so the per-call cost
 * of these helpers is negligible.
 */
function b64encode(input: string): string {
  // btoa expects a Latin-1 string; encodeURIComponent + unescape is the
  // canonical trick for utf-8 → btoa-safe payloads.
  return btoa(unescape(encodeURIComponent(input)))
}

function b64decode(input: string): string {
  return decodeURIComponent(escape(atob(input)))
}
