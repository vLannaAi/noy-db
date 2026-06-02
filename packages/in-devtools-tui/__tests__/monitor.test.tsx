import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { App } from '../src/App.js'
import type { Inspector, InspectorWriteEvent, InspectorWriteConflict } from '@noy-db/in-devtools'
import type { Vault } from '@noy-db/hub'

function fakeInspector() {
  let onWrite: ((e: InspectorWriteEvent) => void) | null = null
  let onConflict: ((c: InspectorWriteConflict) => void) | null = null
  const inspector: Inspector = {
    listVaults: async () => [{ id: 'books', role: 'owner' } as never],
    snapshot: async () => ({ vault: 'books', collections: [{ name: 'invoices', fields: { id: {}, amount: {} } as never, indexes: [] as never, refs: [] as never }] }),
    records: async () => ({ rows: [], total: 0, limit: 20, offset: 0 }),
    subscribe: (h) => { onWrite = h; return () => { onWrite = null } },
    subscribeConflicts: (h) => { onConflict = h; return () => { onConflict = null } },
    pendingWrites: () => ({ pending: false, depth: 0 }),
    meterSnapshot: () => null,
  }
  return {
    inspector,
    emitWrite: (e: InspectorWriteEvent) => onWrite?.(e),
    emitConflict: (c: InspectorWriteConflict) => onConflict?.(c),
  }
}

const W = (over: Partial<InspectorWriteEvent>): InspectorWriteEvent => ({
  op: 'update', vault: 'books', collection: 'invoices', docId: 'inv1',
  before: {}, after: {}, baseVersion: 2, version: 3, userId: 'alice', timestamp: 1_000_000, txId: 't', ...over,
})

describe('write monitor (B2.3)', () => {
  it("'w' opens the monitor and streams writes newest-first; conflicts highlight", async () => {
    const f = fakeInspector()
    const initial = { vaults: await f.inspector.listVaults(), snapshot: await f.inspector.snapshot({} as Vault) }
    const { lastFrame, stdin } = render(<App inspector={f.inspector} vault={{} as Vault} vaultName="books" initial={initial} />)
    await new Promise((r) => setTimeout(r, 100))
    stdin.write('w')
    await new Promise((r) => setTimeout(r, 40))
    f.emitWrite(W({ userId: 'alice', docId: 'inv1', baseVersion: 2, version: 3 }))
    f.emitWrite(W({ userId: 'bob', docId: 'inv1', baseVersion: 2, version: 3 }))
    f.emitConflict({ vault: 'books', collection: 'invoices', docId: 'inv1', local: {}, remote: {}, base: {}, localVersion: 3, remoteVersion: 3, baseVersion: 2 })
    await new Promise((r) => setTimeout(r, 60))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Write Monitor')
    expect(frame).toContain('alice')
    expect(frame).toContain('bob')
    expect(frame).toContain('CONFLICT')
  })
})
