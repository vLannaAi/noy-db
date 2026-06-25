/**
 * RecordsPane PII masking tests — verifies that:
 *   - fields with sensitivity pii/secret render as •••• by default
 *   - the reveal-all key ('r') un-masks all sensitive cells
 *   - public and unclassified fields are always shown
 *   - a collection without described masks nothing (back-compat)
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

/** Navigate to the Records tab for the first collection. */
async function drillToRecords(stdin: NodeJS.WritableStream) {
  await new Promise((r) => setTimeout(r, 120))
  stdin.write('\r')   // enter → drill into first collection
  await new Promise((r) => setTimeout(r, 60))
  stdin.write('\t')   // tab → Records pane
  await new Promise((r) => setTimeout(r, 100))
}

describe('RecordsPane PII masking', () => {
  it('masks pii and secret fields as •••• by default', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('hr')
    const employees = vault.collection<{ id: string; name: string; email: string; salary: number }>('employees', {
      fieldMeta: {
        name:   { label: 'Name' },
        email:  { label: 'Email', sensitivity: 'pii' },
        salary: { label: 'Salary', sensitivity: 'secret' },
      },
    })
    await employees.put('e1', { id: 'e1', name: 'Alice', email: 'alice@example.com', salary: 90000 })
    const inspector = createInspector(db)
    const initial = { vaults: await inspector.listVaults(), snapshot: await inspector.snapshot(vault) }

    const { lastFrame, stdin } = render(<App inspector={inspector} vault={vault} vaultName="hr" initial={initial} />)
    await drillToRecords(stdin)

    const frame = lastFrame() ?? ''
    // PII and secret values must be masked
    expect(frame).toContain('••••')
    expect(frame).not.toContain('alice@example.com')
    expect(frame).not.toContain('90000')
    // Public/unclassified field is shown
    expect(frame).toContain('Alice')
  })

  it('reveal-all key (r) un-masks sensitive fields', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('hr')
    const employees = vault.collection<{ id: string; name: string; email: string }>('employees', {
      fieldMeta: {
        name:  { label: 'Name' },
        email: { label: 'Email', sensitivity: 'pii' },
      },
    })
    await employees.put('e1', { id: 'e1', name: 'Alice', email: 'alice@example.com' })
    const inspector = createInspector(db)
    const initial = { vaults: await inspector.listVaults(), snapshot: await inspector.snapshot(vault) }

    const { lastFrame, stdin } = render(<App inspector={inspector} vault={vault} vaultName="hr" initial={initial} />)
    await drillToRecords(stdin)

    // Default: masked
    expect(lastFrame() ?? '').toContain('••••')
    expect(lastFrame() ?? '').not.toContain('alice@example.com')

    // Press 'r' → reveal all
    stdin.write('r')
    await new Promise((r) => setTimeout(r, 60))
    const revealed = lastFrame() ?? ''
    expect(revealed).toContain('alice@example.com')
    expect(revealed).not.toContain('••••')
  })

  it('public fields are never masked', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('catalog')
    const items = vault.collection<{ id: string; sku: string; price: number }>('items', {
      fieldMeta: {
        sku:   { label: 'SKU', sensitivity: 'public' },
        price: { label: 'Price', sensitivity: 'public' },
      },
    })
    await items.put('i1', { id: 'i1', sku: 'ABC-123', price: 42 })
    const inspector = createInspector(db)
    const initial = { vaults: await inspector.listVaults(), snapshot: await inspector.snapshot(vault) }

    const { lastFrame, stdin } = render(<App inspector={inspector} vault={vault} vaultName="catalog" initial={initial} />)
    await drillToRecords(stdin)

    const frame = lastFrame() ?? ''
    expect(frame).toContain('ABC-123')
    expect(frame).toContain('42')
    expect(frame).not.toContain('••••')
  })

  it('back-compat: no described → no masking', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('legacy')
    // No fieldMeta → no described in snapshot
    const notes = vault.collection<{ id: string; secret: string }>('notes')
    await notes.put('n1', { id: 'n1', secret: 'top-secret-data' })
    const inspector = createInspector(db)
    const initial = { vaults: await inspector.listVaults(), snapshot: await inspector.snapshot(vault) }

    const { lastFrame, stdin } = render(<App inspector={inspector} vault={vault} vaultName="legacy" initial={initial} />)
    await drillToRecords(stdin)

    const frame = lastFrame() ?? ''
    // No masking when no described
    expect(frame).toContain('top-secret-data')
    expect(frame).not.toContain('••••')
  })

  it('reveal-all resets when switching to a different collection', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('hr')
    const employees = vault.collection<{ id: string; name: string; email: string }>('employees', {
      fieldMeta: {
        name:  { label: 'Name' },
        email: { label: 'Email', sensitivity: 'pii' },
      },
    })
    await employees.put('e1', { id: 'e1', name: 'Alice', email: 'alice@example.com' })
    const contacts = vault.collection<{ id: string; tag: string; phone: string }>('contacts', {
      fieldMeta: {
        tag:   { label: 'Tag' },
        phone: { label: 'Phone', sensitivity: 'pii' },
      },
    })
    await contacts.put('c1', { id: 'c1', tag: 'vip', phone: '555-1234' })
    const inspector = createInspector(db)
    const initial = { vaults: await inspector.listVaults(), snapshot: await inspector.snapshot(vault) }

    const { lastFrame, stdin } = render(<App inspector={inspector} vault={vault} vaultName="hr" initial={initial} />)

    // Navigate to Records for the first collection
    await new Promise((r) => setTimeout(r, 120))
    stdin.write('\r')   // enter → drill into first collection (contacts — alphabetical first)
    await new Promise((r) => setTimeout(r, 60))
    stdin.write('\t')   // tab → Records
    await new Promise((r) => setTimeout(r, 120))

    // Verify we're in records pane (masked by default)
    const before = lastFrame() ?? ''
    expect(before).toContain('••••')

    // Press 'r' to reveal
    stdin.write('r')
    await new Promise((r) => setTimeout(r, 80))
    const afterReveal = lastFrame() ?? ''
    // Should be un-masked now (contains real PII from whichever collection is shown)
    expect(afterReveal).not.toContain('••••')

    // Escape back to collection list, move to second collection and drill to Records
    stdin.write('\x1B') // escape → back to list
    await new Promise((r) => setTimeout(r, 60))
    stdin.write('\x1B[B') // down arrow → second collection
    await new Promise((r) => setTimeout(r, 60))
    stdin.write('\r')   // enter → drill
    await new Promise((r) => setTimeout(r, 60))
    stdin.write('\t')   // tab → Records
    await new Promise((r) => setTimeout(r, 120))

    // Reveal should have reset — second collection's PII should be masked
    const frame = lastFrame() ?? ''
    expect(frame).toContain('••••')
  })
})
