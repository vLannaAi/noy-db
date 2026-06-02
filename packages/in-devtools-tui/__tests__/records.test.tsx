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

async function setupRecords() {
  const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
  const vault = await db.openVault('books')
  const notes = vault.collection<{ id: string; n: number }>('notes')
  for (let i = 0; i < 3; i++) await notes.put('n' + i, { id: 'n' + i, n: i })
  const inspector = createInspector(db)
  const initial = { vaults: await inspector.listVaults(), snapshot: await inspector.snapshot(vault) }
  return { inspector, vault, initial }
}

describe('records pane (B2.2)', () => {
  it('Tab switches the detail to Records and shows a paged window', async () => {
    const { inspector, vault, initial } = await setupRecords()
    const { lastFrame, stdin } = render(<App inspector={inspector} vault={vault} vaultName="books" initial={initial} />)
    await new Promise((r) => setTimeout(r, 100))
    stdin.write('\r')   // drill into first collection (notes)
    await new Promise((r) => setTimeout(r, 60))
    stdin.write('\t')   // Tab → Records
    await new Promise((r) => setTimeout(r, 80))
    const frame = lastFrame() ?? ''
    expect(frame).toMatch(/rows 1.\d+ of 3/)
    expect(frame).toContain('n0')
  })
})
