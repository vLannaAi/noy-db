/**
 * Rich-schema rendering tests — verifies that the TUI detail pane renders
 * collection meta.label, rich field descriptors (label/type/widget/markers),
 * the config strip, and vault meta.label when present in the snapshot.
 */
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { createNoydb, ConflictError } from '@noy-db/hub'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { createInspector } from '@noy-db/in-devtools'
import { App } from '../src/App.js'

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const coll = (v: string, c: string) => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) { const m = coll(v, c); const ex = m.get(id); if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v); m.set(id, env) },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async listVaults() { return [...data.keys()] },
    async loadAll(v) { const vm = data.get(v); const s: VaultSnapshot = {}; if (vm) for (const [cn, cm] of vm) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of cm) r[id] = e; s[cn] = r } return s },
    async saveAll() {},
  }
}

async function setup() {
  const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
  const vault = await db.openVault('ledger', { meta: { label: 'Acme Ledger 2026' } })
  vault.collection<{ id: string; amount: number; note: string }>('invoices', {
    meta: { label: 'Sales Invoices', description: 'Outbound sales invoices' },
    fieldMeta: {
      amount: { label: 'Amount', sensitivity: 'pii' },
      note:   { label: 'Note' },
    },
  })
  const inspector = createInspector(db)
  const initial = { vaults: await inspector.listVaults(), snapshot: await inspector.snapshot(vault) }
  return { inspector, vault, initial }
}

describe('TUI rich schema rendering', () => {
  it('shows vault meta.label in the vault list', async () => {
    const { inspector, vault, initial } = await setup()
    const { lastFrame } = render(
      <App inspector={inspector} vault={vault} vaultName="ledger" initial={initial} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Acme Ledger 2026')
  })

  it('shows collection meta.label in the collection list', async () => {
    const { inspector, vault, initial } = await setup()
    const { lastFrame } = render(
      <App inspector={inspector} vault={vault} vaultName="ledger" initial={initial} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Sales Invoices')
  })

  it('drilled detail pane shows label heading + rich fields + sensitivity marker', async () => {
    const { inspector, vault, initial } = await setup()
    const { lastFrame, stdin } = render(
      <App inspector={inspector} vault={vault} vaultName="ledger" initial={initial} />,
    )
    await new Promise((r) => setTimeout(r, 100))
    stdin.write('\r') // enter → drill into first collection
    await new Promise((r) => setTimeout(r, 60))
    const frame = lastFrame() ?? ''
    // Detail heading shows meta.label
    expect(frame).toContain('Sales Invoices')
    // Rich field labels rendered
    expect(frame).toContain('Amount')
    // Sensitivity marker for pii field
    expect(frame).toContain('[pii]')
  })
})
