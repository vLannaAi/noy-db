import { describe, it, expect, vi } from 'vitest'
import type { EncryptedEnvelope, NoydbStore, VaultSnapshot } from '@noy-db/hub'
import { createNoydb } from '@noy-db/hub'
import { toMemory } from '@noy-db/to-memory'
import { guardLocalVault, probeLocalVault } from '../src/index.js'

/** Minimal hand-rolled store for shaping specific probe answers. */
function stubStore(overrides: Partial<NoydbStore>): NoydbStore {
  return {
    name: 'stub',
    async get() {
      return null
    },
    async put() {},
    async delete() {},
    async list() {
      return []
    },
    async loadAll() {
      return {}
    },
    async saveAll() {},
    ...overrides,
  }
}

const fakeEnvelope = { _v: 1 } as unknown as EncryptedEnvelope

describe('probeLocalVault', () => {
  it('reports absent (empty) on a fresh store', async () => {
    const presence = await probeLocalVault(toMemory(), 'firm')
    expect(presence).toEqual({ present: false, reason: 'empty' })
  })

  it('is store-agnostic: finds a real vault via its _keyring marker on to-memory', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'pw' })
    const vault = await db.openVault('firm')
    await vault.collection<{ id: string }>('invoices').put('i1', { id: 'i1' })

    const presence = await probeLocalVault(store, 'firm')
    expect(presence).toEqual({ present: true, via: 'keyring' })

    // A different vault id in the same store is still absent.
    const other = await probeLocalVault(store, 'not-enrolled')
    expect(other.present).toBe(false)
  })

  it('falls back to envelopes when no keyring exists (plaintext-mode vault)', async () => {
    const store = stubStore({
      async loadAll(): Promise<VaultSnapshot> {
        return { invoices: { i1: fakeEnvelope } }
      },
    })
    const presence = await probeLocalVault(store, 'firm')
    expect(presence).toEqual({ present: true, via: 'envelopes' })
  })

  it('ignores collections with zero envelopes in the snapshot', async () => {
    const store = stubStore({
      async loadAll(): Promise<VaultSnapshot> {
        return { invoices: {} }
      },
    })
    const presence = await probeLocalVault(store, 'firm')
    expect(presence).toEqual({ present: false, reason: 'empty' })
  })

  it('never throws: a broken store resolves to probe-failed with the cause', async () => {
    const boom = new Error('idb gone')
    const store = stubStore({
      async list(): Promise<string[]> {
        throw boom
      },
    })
    const presence = await probeLocalVault(store, 'firm')
    expect(presence).toEqual({ present: false, reason: 'probe-failed', cause: boom })
  })
})

describe('guardLocalVault', () => {
  it('fails closed on an empty store: onEvicted invoked, never reported healthy', async () => {
    const onEvicted = vi.fn()
    const result = await guardLocalVault(toMemory(), 'firm', onEvicted)

    expect(result.healthy).toBe(false)
    expect(result.presence).toEqual({ present: false, reason: 'empty' })
    expect(onEvicted).toHaveBeenCalledTimes(1)
    expect(onEvicted).toHaveBeenCalledWith({ present: false, reason: 'empty' })
  })

  it('awaits an async onEvicted handler before returning', async () => {
    let settled = false
    const result = await guardLocalVault(toMemory(), 'firm', async () => {
      await new Promise((r) => setTimeout(r, 10))
      settled = true
    })
    expect(settled).toBe(true)
    expect(result.healthy).toBe(false)
  })

  it('fails closed on a broken store: probe-failed routes to onEvicted, no throw', async () => {
    const boom = new Error('idb gone')
    const store = stubStore({
      async list(): Promise<string[]> {
        throw boom
      },
      async loadAll(): Promise<VaultSnapshot> {
        throw boom
      },
    })
    const onEvicted = vi.fn()
    const result = await guardLocalVault(store, 'firm', onEvicted)

    expect(result.healthy).toBe(false)
    expect(onEvicted).toHaveBeenCalledWith({ present: false, reason: 'probe-failed', cause: boom })
  })

  it('reports healthy on a populated vault and never calls onEvicted', async () => {
    const store = toMemory()
    const db = await createNoydb({ store, user: 'owner', secret: 'pw' })
    const vault = await db.openVault('firm')
    await vault.collection<{ id: string }>('invoices').put('i1', { id: 'i1' })

    const onEvicted = vi.fn()
    const result = await guardLocalVault(store, 'firm', onEvicted)

    expect(result.healthy).toBe(true)
    expect(result.presence).toEqual({ present: true, via: 'keyring' })
    expect(onEvicted).not.toHaveBeenCalled()
  })
})
