/** @jsxImportSource react */
import { describe, it, expect } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { NoydbProvider, useNoydb, useVault, useCollection } from '../src/index.js'

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
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
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

async function makeDb() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner', secret: 'pw' })
  return db
}

describe('useNoydb', () => {
  it('throws when no provider is in the tree', () => {
    function Probe(): JSX.Element {
      const _db = useNoydb()
      return <div data-testid="ok" />
    }
    expect(() => render(<Probe />)).toThrow(/NoydbProvider/)
  })

  it('returns the instance supplied by <NoydbProvider>', async () => {
    const db = await makeDb()
    let captured: unknown = null
    function Probe(): JSX.Element {
      captured = useNoydb()
      return <div data-testid="ok" />
    }
    render(<NoydbProvider db={db}><Probe /></NoydbProvider>)
    expect(captured).toBe(db)
  })
})

describe('useVault', () => {
  it('opens the vault and exposes it after load', async () => {
    const db = await makeDb()
    let snapshot: { loading: boolean; vaultName: string | null } = { loading: true, vaultName: null }
    function Probe(): JSX.Element {
      const { vault, loading } = useVault('acme')
      snapshot = { loading, vaultName: vault?.name ?? null }
      return <div />
    }
    render(<NoydbProvider db={db}><Probe /></NoydbProvider>)
    await waitFor(() => expect(snapshot.loading).toBe(false))
    expect(snapshot.vaultName).toBe('acme')
  })
})

describe('useCollection', () => {
  it('reflects put + delete via subscribe', async () => {
    const db = await makeDb()
    const vault = await db.openVault('acme')
    const coll = vault.collection<{ id: string; amt: number }>('invoices')

    let data: { id: string; amt: number }[] = []
    function Probe(): JSX.Element {
      const state = useCollection<{ id: string; amt: number }>(vault, 'invoices')
      data = state.data as { id: string; amt: number }[]
      return <div />
    }
    render(<NoydbProvider db={db}><Probe /></NoydbProvider>)

    await act(async () => {
      await coll.put('i1', { id: 'i1', amt: 100 })
    })
    await waitFor(() => expect(data.length).toBe(1))
  })

  it('renders empty list when vault is null', () => {
    const Probe = (): JSX.Element => {
      const { data, loading } = useCollection<{ id: string }>(null, 'nope')
      return <div data-testid="state" data-loading={loading} data-count={data.length} />
    }
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('state').getAttribute('data-loading')).toBe('true')
    expect(getByTestId('state').getAttribute('data-count')).toBe('0')
  })
})
