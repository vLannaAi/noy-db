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
  const vault = await db.openVault('books')
  const notes = vault.collection<{ id: string; n: number }>('notes')
  await notes.put('a', { id: 'a', n: 1 })
  await notes.put('b', { id: 'b', n: 2 })
  const tags = vault.collection<{ id: string; n: number }>('tags')
  await tags.put('t', { id: 't', n: 9 })
  const inspector = createInspector(db)
  const initial = { vaults: await inspector.listVaults(), snapshot: await inspector.snapshot(vault) }
  return { inspector, vault, initial }
}

describe('TUI App', () => {
  it('renders the vault and its collections', async () => {
    const { inspector, vault, initial } = await setup()
    const { lastFrame } = render(<App inspector={inspector} vault={vault} vaultName="books" initial={initial} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('books')
    expect(frame).toContain('notes')
    expect(frame).toContain('tags')
  })

  it('down-arrow moves the selection so Enter drills into the SECOND collection', async () => {
    const { inspector, vault, initial } = await setup()
    const { lastFrame, stdin } = render(<App inspector={inspector} vault={vault} vaultName="books" initial={initial} />)
    await new Promise((r) => setTimeout(r, 100)) // let ink useInput effect attach
    stdin.write('\x1B[B') // down arrow → select index 1 (tags)
    stdin.write('\r')       // enter → drill
    await new Promise((r) => setTimeout(r, 50))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('records: 1') // tags has 1 record (notes has 2) → proves movement to index 1
  })
})
