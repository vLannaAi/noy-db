import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

import type {
  Inspector,
  VaultInfo,
  InspectorSnapshot,
  RecordPage,
} from '@noy-db/in-devtools'

// ── Helpers ────────────────────────────────────────────────────────────────

function fakeInspector(snap: InspectorSnapshot, page: RecordPage) {
  const inspector: Inspector = {
    listVaults: async () => [{ id: 'testvault', role: 'owner' } as VaultInfo],
    snapshot: async () => snap,
    records: async () => page,
    subscribe: () => () => {},
    subscribeConflicts: () => () => {},
    pendingWrites: () => ({ pending: false, depth: 0 }),
    meterSnapshot: () => null,
  }
  return inspector
}

const fakeVault = { openVault: vi.fn() } as unknown as import('@noy-db/hub').Noydb

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

async function mountWithRecords(snap: InspectorSnapshot, page: RecordPage) {
  vi.mocked(getActiveNoydb).mockReturnValue(fakeVault)
  vi.mocked(createInspector).mockReturnValue(fakeInspector(snap, page))
  vi.mocked(fakeVault.openVault).mockResolvedValue({} as never)
  const wrapper = mount(DevtoolsPanel)
  await flushPromises()
  // Switch to Records tab
  const tabs = wrapper.findAll('.noydb-detail-tab')
  const recordsTab = tabs.find(t => t.text() === 'Records')
  await recordsTab!.trigger('click')
  await flushPromises()
  return wrapper
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('RecordsPane — PII masking', () => {
  const snap: InspectorSnapshot = {
    vault: 'testvault',
    collections: [{
      name: 'contacts',
      fields: {
        vat: { type: 'string' } as never,
        total: { type: 'string' } as never,
      },
      indexes: [],
      refs: [],
      described: [
        {
          key: 'vat',
          type: 'string',
          optional: false,
          label: 'VAT Number',
          sensitivity: 'pii',
          widget: 'text',
          editable: true,
        },
        {
          key: 'total',
          type: 'string',
          optional: false,
          label: 'Total',
          sensitivity: 'public',
          widget: 'text',
          editable: true,
        },
      ],
    }],
  }

  const page: RecordPage = {
    rows: [{ vat: 'IT123', total: '10.00' }],
    total: 1,
    limit: 20,
    offset: 0,
  }

  it('masks pii values by default and shows public values', async () => {
    const wrapper = await mountWithRecords(snap, page)
    expect(wrapper.text()).toContain('••••••')      // vat masked
    expect(wrapper.text()).toContain('10.00')        // public total shown
    expect(wrapper.text()).not.toContain('IT123')    // pii hidden
  })

  it('reveals a masked field when its reveal control is clicked', async () => {
    const wrapper = await mountWithRecords(snap, page)
    expect(wrapper.text()).not.toContain('IT123')
    await wrapper.find('[data-reveal="vat"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('IT123')
  })

  it('masks secret fields by default', async () => {
    const secretSnap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'keys',
        fields: { apiKey: { type: 'string' } as never },
        indexes: [],
        refs: [],
        described: [
          {
            key: 'apiKey',
            type: 'string',
            optional: false,
            label: 'API Key',
            sensitivity: 'secret',
            widget: 'text',
            editable: false,
          },
        ],
      }],
    }
    const secretPage: RecordPage = {
      rows: [{ apiKey: 'sk-supersecret' }],
      total: 1,
      limit: 20,
      offset: 0,
    }
    const wrapper = await mountWithRecords(secretSnap, secretPage)
    expect(wrapper.text()).toContain('••••••')
    expect(wrapper.text()).not.toContain('sk-supersecret')
  })

  it('reveals all fields when the "reveal all" toggle is clicked', async () => {
    const wrapper = await mountWithRecords(snap, page)
    expect(wrapper.text()).not.toContain('IT123')
    await wrapper.find('[data-reveal-all]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('IT123')
  })

  it('masks nothing when described is absent (back-compat)', async () => {
    const noDescSnap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'invoices',
        fields: {
          id: { type: 'string' } as never,
          amount: { type: 'string' } as never,
        },
        indexes: [],
        refs: [],
        // no described
      }],
    }
    const noDescPage: RecordPage = {
      rows: [{ id: 'inv001', amount: '9.99' }],
      total: 1,
      limit: 20,
      offset: 0,
    }
    const wrapper = await mountWithRecords(noDescSnap, noDescPage)
    expect(wrapper.text()).toContain('inv001')
    expect(wrapper.text()).toContain('9.99')
    expect(wrapper.text()).not.toContain('••••••')
  })

  it('treats a field not in described as not-sensitive', async () => {
    const partialDescSnap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'mixed',
        fields: {
          name: { type: 'string' } as never,
          extra: { type: 'string' } as never,
        },
        indexes: [],
        refs: [],
        described: [
          {
            key: 'name',
            type: 'string',
            optional: false,
            label: 'Name',
            sensitivity: 'pii',
            widget: 'text',
            editable: true,
          },
          // 'extra' not in described
        ],
      }],
    }
    const partialPage: RecordPage = {
      rows: [{ name: 'Alice', extra: 'visible' }],
      total: 1,
      limit: 20,
      offset: 0,
    }
    const wrapper = await mountWithRecords(partialDescSnap, partialPage)
    expect(wrapper.text()).toContain('••••••')
    expect(wrapper.text()).not.toContain('Alice')
    expect(wrapper.text()).toContain('visible') // extra not in described → shown
  })
})
