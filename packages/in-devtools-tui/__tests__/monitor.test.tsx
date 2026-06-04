import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { App } from '../src/App.js'
import type { Inspector, InspectorWriteEvent, InspectorWriteConflict } from '@noy-db/in-devtools'
import type { Vault } from '@noy-db/hub'
import type { MeterSnapshot } from '@noy-db/to-meter'

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
  const meterSnap = {
    status: 'degraded', totalCalls: 50, casConflicts: 0, windowMs: 1000, collectedAt: 'x',
    byMethod: { put: { count: 43, errors: 0, p50: 11, p90: 60, p99: 92, max: 120, avg: 20 }, delete: { count: 5, errors: 0, p50: 4, p90: 7, p99: 9, max: 12, avg: 5 } },
  } as unknown as MeterSnapshot

  it('shows the latency readout when the store is metered, hidden when not', async () => {
    const f = fakeInspector()
    ;(f.inspector as { meterSnapshot: () => MeterSnapshot | null }).meterSnapshot = () => meterSnap
    const initial = { vaults: await f.inspector.listVaults(), snapshot: await f.inspector.snapshot({} as never) }
    const { lastFrame, stdin } = render(<App inspector={f.inspector} vault={{} as never} vaultName="books" initial={initial} />)
    await new Promise((r) => setTimeout(r, 100))
    stdin.write('w')
    await new Promise((r) => setTimeout(r, 60))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('put p50 11ms p99 92ms')
    expect(frame).toContain('degraded')
  })

  it('flags a write whose conflict arrived BEFORE the write (sticky)', async () => {
    const f = fakeInspector()
    const initial = { vaults: await f.inspector.listVaults(), snapshot: await f.inspector.snapshot({} as never) }
    const { lastFrame, stdin } = render(<App inspector={f.inspector} vault={{} as never} vaultName="books" initial={initial} />)
    await new Promise((r) => setTimeout(r, 100))
    stdin.write('w')
    await new Promise((r) => setTimeout(r, 40))
    // conflict arrives FIRST, then the write for the same collection/docId@baseVersion
    f.emitConflict({ vault: 'books', collection: 'invoices', docId: 'inv9', local: {}, remote: {}, base: {}, localVersion: 3, remoteVersion: 3, baseVersion: 2 })
    await new Promise((r) => setTimeout(r, 20))
    f.emitWrite(W({ userId: 'carol', docId: 'inv9', baseVersion: 2, version: 3 }))
    await new Promise((r) => setTimeout(r, 50))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('carol')
    expect(frame).toContain('CONFLICT')
  })

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
