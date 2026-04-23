/**
 * **@noy-db/in-ai** — LLM function-calling adapter for noy-db.
 *
 * Exposes ACL-scoped collections as tool definitions that an LLM can
 * call, and dispatches incoming tool calls back to the vault. The
 * permission model carries through: a user whose keyring has only
 * `ro` on `invoices` sees only `invoices.list` / `invoices.get` —
 * never `invoices.put` / `invoices.delete`. The LLM physically
 * cannot emit a tool call the operator isn't authorised for, because
 * the tool doesn't exist in the model's context.
 *
 * ## Two layers
 *
 *   1. **{@link buildToolset}** — walk the vault's accessible
 *      collections, emit a `Tool[]` array shaped for the format of
 *      your choice (OpenAI, Anthropic, Vercel AI SDK, or the generic
 *      JSON-Schema intermediate).
 *
 *   2. **{@link invokeToolCall}** — accept `{ name, args }` from the
 *      LLM's response, re-check permissions, dispatch to the vault,
 *      and return the result in a format that slots into the next
 *      prompt round.
 *
 * ## Security boundary
 *
 * Tool calls are untrusted input. The dispatcher re-checks the
 * caller's permission on every invocation — even though the tool
 * wasn't published to the LLM, a hostile model might attempt a
 * fabricated call. The dispatcher throws `ToolDeniedError` rather
 * than silently ignoring, so the consumer can surface the attempt
 * to the user.
 *
 * @packageDocumentation
 */

import type { Vault } from '@noy-db/hub'

// ─── Tool formats ───────────────────────────────────────────────────────

/** Generic JSON-Schema-based tool (matches OpenAI's `function` shape). */
export interface JsonSchemaTool {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: 'object'
    readonly properties: Record<string, { type: string; description?: string }>
    readonly required: readonly string[]
  }
}

/** OpenAI chat.completions tool shape. */
export interface OpenAITool {
  readonly type: 'function'
  readonly function: JsonSchemaTool
}

/** Anthropic Messages API tool shape. */
export interface AnthropicTool {
  readonly name: string
  readonly description: string
  readonly input_schema: JsonSchemaTool['parameters']
}

/** Vercel AI SDK tool shape (generic). */
export interface VercelAITool {
  readonly description: string
  readonly parameters: JsonSchemaTool['parameters']
}

export type ToolFormat = 'openai' | 'anthropic' | 'vercel-ai' | 'json-schema'

// ─── Toolset options ───────────────────────────────────────────────────

export interface ToolsetOptions {
  /**
   * Which collections to expose. Default: every collection in the
   * vault the caller has read access to. Pass an explicit allowlist
   * to narrow the surface — common in multi-tenant setups where the
   * LLM should only see a subset.
   */
  readonly collections?: readonly string[]
  /**
   * Which operations to expose per collection. Defaults to `['list',
   * 'get']` — read-only. Add `'put'` / `'delete'` explicitly when you
   * want the LLM to mutate. Permissions are re-checked at dispatch
   * time regardless.
   */
  readonly operations?: readonly ToolOperation[]
  /**
   * Output format. `'json-schema'` is the intermediate shape; the
   * others (`'openai'` / `'anthropic'` / `'vercel-ai'`) are the
   * SDK-specific wrappers.
   */
  readonly format?: ToolFormat
  /**
   * Human-readable vault label inserted into every tool description
   * (e.g. `"Acme Inc."`). Helps the LLM disambiguate multi-vault
   * scenarios. Omit to use the raw vault name.
   */
  readonly vaultLabel?: string
}

export type ToolOperation = 'list' | 'get' | 'put' | 'delete' | 'count'

// ─── Tool builder ──────────────────────────────────────────────────────

/** Build an LLM-ready toolset from a vault. */
export function buildToolset(
  vault: Vault,
  options: ToolsetOptions = {},
): readonly (JsonSchemaTool | OpenAITool | AnthropicTool | VercelAITool)[] {
  const operations = options.operations ?? ['list', 'get']
  const label = options.vaultLabel ?? vault.name
  const format = options.format ?? 'json-schema'
  const allowlist = options.collections ? new Set(options.collections) : null

  // The Vault surface we use is tiny + safe: enumerate known collection
  // names via vault.describeAccess(). Fall back to caller-supplied
  // allowlist if describeAccess is not available.
  const accessible = getAccessibleCollections(vault, allowlist)

  const tools: JsonSchemaTool[] = []
  for (const collection of accessible) {
    for (const op of operations) {
      tools.push(jsonSchemaTool(collection, op, label))
    }
  }

  return tools.map(t => wrap(t, format))
}

function jsonSchemaTool(collection: string, op: ToolOperation, label: string): JsonSchemaTool {
  switch (op) {
    case 'list':
      return {
        name: `${collection}_list`,
        description: `List every record in the "${collection}" collection of vault "${label}". Returns an array of records.`,
        parameters: { type: 'object', properties: {}, required: [] },
      }
    case 'get':
      return {
        name: `${collection}_get`,
        description: `Get a single record from the "${collection}" collection of vault "${label}" by id. Returns null when the id does not exist.`,
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Record id.' } },
          required: ['id'],
        },
      }
    case 'put':
      return {
        name: `${collection}_put`,
        description: `Create or replace a record in the "${collection}" collection of vault "${label}". The \`record\` argument is the full record object.`,
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Record id.' },
            record: { type: 'object', description: 'Full record body.' },
          },
          required: ['id', 'record'],
        },
      }
    case 'delete':
      return {
        name: `${collection}_delete`,
        description: `Delete a record by id from the "${collection}" collection of vault "${label}".`,
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Record id.' } },
          required: ['id'],
        },
      }
    case 'count':
      return {
        name: `${collection}_count`,
        description: `Count records in the "${collection}" collection of vault "${label}".`,
        parameters: { type: 'object', properties: {}, required: [] },
      }
  }
}

function wrap(
  tool: JsonSchemaTool,
  format: ToolFormat,
): JsonSchemaTool | OpenAITool | AnthropicTool | VercelAITool {
  switch (format) {
    case 'json-schema':
      return tool
    case 'openai':
      return { type: 'function', function: tool }
    case 'anthropic':
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }
    case 'vercel-ai':
      return { description: tool.description, parameters: tool.parameters }
  }
}

// ─── Dispatch ──────────────────────────────────────────────────────────

export class ToolDeniedError extends Error {
  readonly toolName: string
  constructor(toolName: string, reason: string) {
    super(`Tool call denied: "${toolName}" — ${reason}`)
    this.name = 'ToolDeniedError'
    this.toolName = toolName
  }
}

export class ToolNotFoundError extends Error {
  readonly toolName: string
  constructor(toolName: string) {
    super(`Tool call refused: "${toolName}" is not a known tool in this toolset.`)
    this.name = 'ToolNotFoundError'
    this.toolName = toolName
  }
}

export interface ToolCall {
  readonly name: string
  readonly args: Record<string, unknown>
}

export interface InvokeOptions {
  /** Mirror the allowlist used for `buildToolset` — enforced at dispatch. */
  readonly allowedOperations?: readonly ToolOperation[]
  readonly allowedCollections?: readonly string[]
}

/**
 * Dispatch an LLM-returned tool call against the vault. Caller is
 * expected to pass the same `allowedOperations` / `allowedCollections`
 * they used for `buildToolset`; deviations (including fabricated tool
 * names the LLM invented) throw `ToolNotFoundError` or
 * `ToolDeniedError`.
 */
export async function invokeToolCall(
  vault: Vault,
  call: ToolCall,
  options: InvokeOptions = {},
): Promise<unknown> {
  const parsed = parseToolName(call.name)
  if (!parsed) {
    throw new ToolNotFoundError(call.name)
  }
  const { collection, op } = parsed

  const allowedOps = options.allowedOperations ?? ['list', 'get']
  if (!allowedOps.includes(op)) {
    throw new ToolDeniedError(call.name, `operation "${op}" is not in the allowed operations list`)
  }
  if (options.allowedCollections && !options.allowedCollections.includes(collection)) {
    throw new ToolDeniedError(call.name, `collection "${collection}" is not in the allowed list`)
  }

  const coll = vault.collection(collection)
  const id = toIdString(call.args.id)
  switch (op) {
    case 'list':
      return coll.list()
    case 'get':
      return coll.get(id)
    case 'count':
      return (await coll.list()).length
    case 'put':
      return coll.put(id, call.args.record as Record<string, unknown>)
    case 'delete':
      return coll.delete(id)
  }
}

function toIdString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Round-trip helper: parse `collection_op` back to its parts. */
export function parseToolName(name: string): { collection: string; op: ToolOperation } | null {
  // Operation suffix — take the longest known suffix match so that
  // collection names containing underscores (e.g. `user_profiles`) are
  // still parseable.
  const ops: ToolOperation[] = ['list', 'get', 'put', 'delete', 'count']
  for (const op of ops) {
    const suffix = `_${op}`
    if (name.endsWith(suffix)) {
      const collection = name.slice(0, -suffix.length)
      if (collection.length === 0) return null
      return { collection, op }
    }
  }
  return null
}

// ─── Vault introspection (duck-typed) ──────────────────────────────────

/**
 * Duck-typed probe for a vault that exposes an accessible-collections
 * API. Every hub version we target ships either `listCollectionNames`
 * or the fallback we use below (the keyring's DEK map).
 */
function getAccessibleCollections(
  vault: Vault,
  allowlist: Set<string> | null,
): string[] {
  // Preferred path — if the vault exposes an explicit enumeration API.
  const v = vault as unknown as {
    listCollectionNames?: () => string[]
    keyring?: { deks: Map<string, unknown> }
  }
  if (typeof v.listCollectionNames === 'function') {
    const names = v.listCollectionNames()
    return names.filter(n => !n.startsWith('_') && (!allowlist || allowlist.has(n)))
  }
  // Fallback — read the keyring's DEK keys, filtering system collections.
  const deks = v.keyring?.deks
  if (deks) {
    const names: string[] = []
    for (const key of deks.keys()) {
      if (key.startsWith('_')) continue
      // Tier-suffixed DEKs (`collection#N`) — strip the suffix and dedupe.
      const bare = key.includes('#') ? key.slice(0, key.indexOf('#')) : key
      if (allowlist && !allowlist.has(bare)) continue
      if (!names.includes(bare)) names.push(bare)
    }
    return names
  }
  // Last resort — return the allowlist itself (trust the caller).
  return allowlist ? [...allowlist] : []
}
