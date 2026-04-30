/**
 * Showcase 46 — in-ai (LLM tool-calling adapter)
 *
 * What you'll learn
 * ─────────────────
 * `buildToolset(vault, { format: 'openai' })` produces an array of
 * function-calling tools — one per (collection × operation) — in the
 * shape OpenAI / Anthropic / Vercel AI SDK / raw JSON-Schema expect.
 * `invokeToolCall(vault, name, args)` is the dispatcher: it parses the
 * generated tool name back to `{ collection, op }` and calls the
 * matching encrypted-aware handler.
 *
 * Why it matters
 * ──────────────
 * "Show the user a summary of their unpaid invoices" — that intent
 * collapses into LLM tool calls. The adapter keeps the LLM out of the
 * encryption boundary: it never sees DEKs, only the decrypted records
 * the host process chose to expose.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 06-multi-user.
 *
 * What to read next
 * ─────────────────
 *   - showcase 47-in-rest (HTTP handler over the same surface)
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-ai
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { buildToolset, parseToolName, type OpenAITool } from '@noy-db/in-ai'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; amt: number }

describe('Showcase 46 — in-ai', () => {
  it('buildToolset emits OpenAI-shape tools with collection_op naming', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'in-ai-pass-2026' })
    const vault = await db.openVault('demo')
    await vault.collection<Invoice>('invoices').put('i1', { id: 'i1', amt: 100 })

    const tools = buildToolset(vault, {
      format: 'openai',
      operations: ['list', 'get'],
      collections: ['invoices'],
    }) as OpenAITool[]

    // One tool per (collection × operation) — listing + get for invoices.
    expect(tools).toHaveLength(2)
    const names = tools.map((t) => t.function.name).sort()
    expect(names).toEqual(['invoices_get', 'invoices_list'])

    // The reverse parse round-trips.
    expect(parseToolName('invoices_list')).toEqual({ collection: 'invoices', op: 'list' })

    // Each tool carries an OpenAI-shape function spec.
    expect(tools[0]!.type).toBe('function')
    expect(tools[0]!.function.parameters).toBeDefined()

    db.close()
  })
})
