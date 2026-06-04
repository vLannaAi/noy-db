import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// ── Fake inspector ───────────────────────────────────────────────
import type {
  Inspector,
  InspectorWriteEvent,
  InspectorWriteConflict,
  VaultInfo,
  InspectorSnapshot,
  RecordPage,
} from '@noy-db/in-devtools'

function fakeInspector(overrides: Partial<{
  vaults: VaultInfo[]
  snap: InspectorSnapshot
  page: RecordPage
}> = {}) {
  let onWrite: ((e: InspectorWriteEvent) => void) | null = null
  let onConflict: ((c: InspectorWriteConflict) => void) | null = null

  const inspector: Inspector = {
    listVaults: async () => overrides.vaults ?? [{ id: 'myvault', role: 'owner' } as VaultInfo],
    snapshot: async () => overrides.snap ?? {
      vault: 'myvault',
      collections: [{
        name: 'invoices',
        fields: { id: { type: 'string' } as never, amount: { type: 'number' } as never },
        indexes: [],
        refs: [],
        stats: { count: 5, bytes: 1024 },
      }],
    },
    records: async () => overrides.page ?? {
      rows: [{ id: 'inv001', amount: 100 }, { id: 'inv002', amount: 200 }],
      total: 5,
      limit: 2,
      offset: 0,
    },
    subscribe: (h) => { onWrite = h; return () => { onWrite = null } },
    subscribeConflicts: (h) => { onConflict = h; return () => { onConflict = null } },
    pendingWrites: () => ({ pending: false, depth: 0 }),
    meterSnapshot: () => null,
  }
  return {
    inspector,
    emit: (e: InspectorWriteEvent) => onWrite?.(e),
    emitConflict: (c: InspectorWriteConflict) => onConflict?.(c),
  }
}

const fakeVault = { openVault: vi.fn() } as unknown as import('@noy-db/hub').Noydb

// ── Module mocks ─────────────────────────────────────────────────
vi.mock('@noy-db/in-pinia', () => ({
  getActiveNoydb: vi.fn(),
}))

vi.mock('@noy-db/in-devtools', () => ({
  createInspector: vi.fn(),
}))

import { getActiveNoydb } from '@noy-db/in-pinia'
import { createInspector } from '@noy-db/in-devtools'
import DevtoolsPanel from '../src/runtime/devtools/DevtoolsPanel.vue'

beforeEach(() => {
  vi.mocked(getActiveNoydb).mockReset()
  vi.mocked(createInspector).mockReset()
  vi.mocked(fakeVault.openVault).mockReset()
})

// ── Tests ─────────────────────────────────────────────────────────
describe('DevtoolsPanel — empty state', () => {
  it('shows setup tip when getActiveNoydb returns null', async () => {
    vi.mocked(getActiveNoydb).mockReturnValue(null)
    const wrapper = mount(DevtoolsPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('setActiveNoydb')
  })

  it('shows "no open vaults" when listVaults returns []', async () => {
    const f = fakeInspector({ vaults: [] })
    vi.mocked(getActiveNoydb).mockReturnValue(fakeVault)
    vi.mocked(createInspector).mockReturnValue(f.inspector)
    vi.mocked(fakeVault.openVault).mockResolvedValue({} as never)
    const wrapper = mount(DevtoolsPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('No open vaults')
  })
})

describe('DevtoolsPanel — Structure tab', () => {
  it('shows vault name and collection list after mount', async () => {
    const f = fakeInspector()
    vi.mocked(getActiveNoydb).mockReturnValue(fakeVault)
    vi.mocked(createInspector).mockReturnValue(f.inspector)
    vi.mocked(fakeVault.openVault).mockResolvedValue({} as never)
    const wrapper = mount(DevtoolsPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('myvault')
    expect(wrapper.text()).toContain('invoices')
  })

  it('shows schema fields for the auto-selected collection', async () => {
    const f = fakeInspector()
    vi.mocked(getActiveNoydb).mockReturnValue(fakeVault)
    vi.mocked(createInspector).mockReturnValue(f.inspector)
    vi.mocked(fakeVault.openVault).mockResolvedValue({} as never)
    const wrapper = mount(DevtoolsPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('id')
    expect(wrapper.text()).toContain('amount')
  })

  it('switches to Records tab and shows paged rows', async () => {
    const f = fakeInspector()
    vi.mocked(getActiveNoydb).mockReturnValue(fakeVault)
    vi.mocked(createInspector).mockReturnValue(f.inspector)
    vi.mocked(fakeVault.openVault).mockResolvedValue({} as never)
    const wrapper = mount(DevtoolsPanel)
    await flushPromises()
    // Click Records tab
    const tabs = wrapper.findAll('.noydb-detail-tab')
    const recordsTab = tabs.find(t => t.text() === 'Records')
    expect(recordsTab).toBeDefined()
    await recordsTab!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('inv001')
    expect(wrapper.text()).toContain('1–2')    // rows 1–2 of 5 (en-dash U+2013)
    expect(wrapper.text()).toContain('5')
  })

  it('shows records error message when records() rejects', async () => {
    const f = fakeInspector()
    vi.mocked(getActiveNoydb).mockReturnValue(fakeVault)
    vi.mocked(createInspector).mockReturnValue({ ...f.inspector, records: async () => { throw new Error('db locked') } })
    vi.mocked(fakeVault.openVault).mockResolvedValue({} as never)
    const wrapper = mount(DevtoolsPanel)
    await flushPromises()
    const tabs = wrapper.findAll('.noydb-detail-tab')
    const recordsTab = tabs.find(t => t.text() === 'Records')
    await recordsTab!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('db locked')
  })
})

describe('DevtoolsPanel — Monitor tab', () => {
  it('opens monitor and renders feed rows after write events', async () => {
    const f = fakeInspector()
    vi.mocked(getActiveNoydb).mockReturnValue(fakeVault)
    vi.mocked(createInspector).mockReturnValue(f.inspector)
    vi.mocked(fakeVault.openVault).mockResolvedValue({} as never)
    const wrapper = mount(DevtoolsPanel)
    await flushPromises()
    // Open monitor
    await wrapper.find('.noydb-nav__tab:last-of-type').trigger('click')
    await flushPromises()
    // Emit a write event
    f.emit({
      op: 'update', vault: 'myvault', collection: 'invoices', docId: 'inv1',
      before: {}, after: {}, baseVersion: 1, version: 2,
      userId: 'alice', timestamp: Date.now(), txId: 't1',
    } as InspectorWriteEvent)
    await flushPromises()
    expect(wrapper.text()).toContain('alice')
    expect(wrapper.text()).toContain('invoices/inv1')
  })

  it('highlights conflict rows when subscribeConflicts fires', async () => {
    const f = fakeInspector()
    vi.mocked(getActiveNoydb).mockReturnValue(fakeVault)
    vi.mocked(createInspector).mockReturnValue(f.inspector)
    vi.mocked(fakeVault.openVault).mockResolvedValue({} as never)
    const wrapper = mount(DevtoolsPanel)
    await flushPromises()
    await wrapper.find('.noydb-nav__tab:last-of-type').trigger('click')
    f.emit({
      op: 'update', vault: 'myvault', collection: 'invoices', docId: 'inv1',
      before: {}, after: {}, baseVersion: 1, version: 2,
      userId: 'alice', timestamp: Date.now(), txId: 't1',
    } as InspectorWriteEvent)
    f.emitConflict({
      vault: 'myvault', collection: 'invoices', docId: 'inv1',
      local: {}, remote: {}, base: {}, localVersion: 2, remoteVersion: 2, baseVersion: 1,
    } as InspectorWriteConflict)
    await flushPromises()
    expect(wrapper.find('.noydb-monitor__row--conflict').exists()).toBe(true)
    expect(wrapper.text()).toContain('conflict')
  })

  it('shows latency bar when meterSnapshot returns a snapshot', async () => {
    vi.useFakeTimers()
    const meterSnap = {
      status: 'ok', totalCalls: 10, casConflicts: 0, windowMs: 1000, collectedAt: 'x',
      byMethod: { put: { count: 10, errors: 0, p50: 8, p90: 20, p99: 35, max: 50, avg: 10 } },
    } as never
    const f = fakeInspector()
    const inspector = { ...f.inspector, meterSnapshot: () => meterSnap }
    vi.mocked(getActiveNoydb).mockReturnValue(fakeVault)
    vi.mocked(createInspector).mockReturnValue(inspector)
    vi.mocked(fakeVault.openVault).mockResolvedValue({} as never)
    const wrapper = mount(DevtoolsPanel)
    await flushPromises()
    // Open monitor tab — this starts the setInterval
    await wrapper.find('.noydb-nav__tab:last-of-type').trigger('click')
    await flushPromises()
    // Advance past 1000ms so the interval fires
    vi.advanceTimersByTime(1001)
    await wrapper.vm.$nextTick()
    // Latency bar should now be visible with p50 value from the snapshot
    expect(wrapper.find('.noydb-monitor__latency').exists()).toBe(true)
    expect(wrapper.text()).toContain('8ms')   // put p50 = 8
    vi.useRealTimers()
  })

  it('marks both rows as conflict when two users write to the same base version', async () => {
    const f = fakeInspector()
    vi.mocked(getActiveNoydb).mockReturnValue(fakeVault)
    vi.mocked(createInspector).mockReturnValue(f.inspector)
    vi.mocked(fakeVault.openVault).mockResolvedValue({} as never)
    const wrapper = mount(DevtoolsPanel)
    await flushPromises()
    await wrapper.find('.noydb-nav__tab:last-of-type').trigger('click')
    await flushPromises()
    // Alice writes at baseVersion 1
    f.emit({
      op: 'update', vault: 'myvault', collection: 'invoices', docId: 'inv42',
      before: {}, after: {}, baseVersion: 1, version: 2,
      userId: 'alice', timestamp: Date.now(), txId: 'tx-a',
    } as InspectorWriteEvent)
    // Bob writes at the same baseVersion 1 — inline conflict detected
    f.emit({
      op: 'update', vault: 'myvault', collection: 'invoices', docId: 'inv42',
      before: {}, after: {}, baseVersion: 1, version: 2,
      userId: 'bob', timestamp: Date.now(), txId: 'tx-b',
    } as InspectorWriteEvent)
    await flushPromises()
    const conflictRows = wrapper.findAll('.noydb-monitor__row--conflict')
    expect(conflictRows.length).toBe(2)
  })
})
