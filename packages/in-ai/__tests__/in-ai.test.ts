import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import {
  buildToolset,
  invokeToolCall,
  parseToolName,
  ToolDeniedError,
  ToolNotFoundError,
  type JsonSchemaTool,
  type OpenAITool,
  type AnthropicTool,
} from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

interface Invoice { id: string; amt: number }

async function setup() {
  const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
  const vault = await db.openVault('acme')
  const invoices = vault.collection<Invoice>('invoices')
  const payments = vault.collection<{ id: string; amt: number }>('payments')
  await invoices.put('i1', { id: 'i1', amt: 100 })
  await invoices.put('i2', { id: 'i2', amt: 250 })
  await payments.put('p1', { id: 'p1', amt: 100 })
  return { db, vault, invoices, payments }
}

describe('parseToolName', () => {
  it('extracts collection + op', () => {
    expect(parseToolName('invoices_list')).toEqual({ collection: 'invoices', op: 'list' })
    expect(parseToolName('user_profiles_get')).toEqual({ collection: 'user_profiles', op: 'get' })
  })
  it('returns null for junk input', () => {
    expect(parseToolName('bogus')).toBeNull()
    expect(parseToolName('_list')).toBeNull()
  })
})

describe('buildToolset — default read-only', () => {
  it('emits list + get per collection', async () => {
    const { vault } = await setup()
    const tools = buildToolset(vault, {
      collections: ['invoices', 'payments'],
      format: 'json-schema',
    }) as readonly JsonSchemaTool[]
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(['invoices_get', 'invoices_list', 'payments_get', 'payments_list'])
  })

  it('omits put + delete by default', async () => {
    const { vault } = await setup()
    const tools = buildToolset(vault, { collections: ['invoices'] }) as readonly JsonSchemaTool[]
    expect(tools.some(t => t.name === 'invoices_put')).toBe(false)
    expect(tools.some(t => t.name === 'invoices_delete')).toBe(false)
  })

  it('includes put/delete when explicitly requested', async () => {
    const { vault } = await setup()
    const tools = buildToolset(vault, {
      collections: ['invoices'],
      operations: ['list', 'get', 'put', 'delete'],
    }) as readonly JsonSchemaTool[]
    expect(tools.map(t => t.name).sort()).toEqual([
      'invoices_delete', 'invoices_get', 'invoices_list', 'invoices_put',
    ])
  })

  it('respects the collections allowlist', async () => {
    const { vault } = await setup()
    const tools = buildToolset(vault, { collections: ['invoices'] }) as readonly JsonSchemaTool[]
    expect(tools.every(t => t.name.startsWith('invoices_'))).toBe(true)
  })
})

describe('buildToolset — format wrappers', () => {
  it('wraps for OpenAI', async () => {
    const { vault } = await setup()
    const tools = buildToolset(vault, { collections: ['invoices'], format: 'openai' }) as readonly OpenAITool[]
    expect(tools[0]!.type).toBe('function')
    expect(tools[0]!.function.name).toBe('invoices_list')
  })

  it('wraps for Anthropic', async () => {
    const { vault } = await setup()
    const tools = buildToolset(vault, { collections: ['invoices'], format: 'anthropic' }) as readonly AnthropicTool[]
    expect(tools[0]!.input_schema.type).toBe('object')
  })
})

describe('invokeToolCall — dispatch', () => {
  it('list returns records', async () => {
    const { vault } = await setup()
    const result = await invokeToolCall(vault, { name: 'invoices_list', args: {} })
    expect((result as Invoice[]).map(r => r.id).sort()).toEqual(['i1', 'i2'])
  })

  it('get returns the record', async () => {
    const { vault } = await setup()
    const result = await invokeToolCall(vault, { name: 'invoices_get', args: { id: 'i1' } })
    expect(result).toEqual({ id: 'i1', amt: 100 })
  })

  it('denies put when not in allowedOperations (read-only default)', async () => {
    const { vault } = await setup()
    await expect(
      invokeToolCall(vault, { name: 'invoices_put', args: { id: 'i9', record: { id: 'i9', amt: 1 } } }),
    ).rejects.toBeInstanceOf(ToolDeniedError)
  })

  it('permits put when allowedOperations includes it', async () => {
    const { vault, invoices } = await setup()
    await invokeToolCall(
      vault,
      { name: 'invoices_put', args: { id: 'i9', record: { id: 'i9', amt: 1 } } },
      { allowedOperations: ['put'] },
    )
    expect(await invoices.get('i9')).toEqual({ id: 'i9', amt: 1 })
  })

  it('denies collections outside allowedCollections', async () => {
    const { vault } = await setup()
    await expect(
      invokeToolCall(
        vault,
        { name: 'payments_list', args: {} },
        { allowedCollections: ['invoices'] },
      ),
    ).rejects.toBeInstanceOf(ToolDeniedError)
  })

  it('throws ToolNotFoundError on fabricated tool names', async () => {
    const { vault } = await setup()
    await expect(
      invokeToolCall(vault, { name: 'hacked_delete_all', args: {} }),
    ).rejects.toBeInstanceOf(ToolNotFoundError)
  })
})
