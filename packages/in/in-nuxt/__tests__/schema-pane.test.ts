import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

import type {
  Inspector,
  InspectorWriteEvent,
  InspectorWriteConflict,
  VaultInfo,
  InspectorSnapshot,
  RecordPage,
} from '@noy-db/in-devtools'

// ── Helper: a minimal fakeInspector (same pattern as devtools-panel.test.ts) ──
function fakeInspector(snap: InspectorSnapshot) {
  const inspector: Inspector = {
    listVaults: async () => [{ id: 'testvault', role: 'owner' } as VaultInfo],
    snapshot: async () => snap,
    records: async () => ({ rows: [], total: 0, limit: 20, offset: 0 } as RecordPage),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function mountWithSnap(snap: InspectorSnapshot) {
  vi.mocked(getActiveNoydb).mockReturnValue(fakeVault)
  vi.mocked(createInspector).mockReturnValue(fakeInspector(snap))
  vi.mocked(fakeVault.openVault).mockResolvedValue({} as never)
  const wrapper = mount(DevtoolsPanel)
  await flushPromises()
  return wrapper
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SchemaPane — meta header', () => {
  it('shows collection meta label when present', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'invoices',
        fields: { id: { type: 'string' } as never },
        indexes: [],
        refs: [],
        meta: { label: 'Invoice', description: 'All invoices' },
      }],
    }
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.text()).toContain('Invoice')
    expect(wrapper.text()).toContain('All invoices')
  })

  it('falls back to collection name when meta.label is absent', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'orders',
        fields: { id: { type: 'string' } as never },
        indexes: [],
        refs: [],
      }],
    }
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.text()).toContain('orders')
  })
})

describe('SchemaPane — sensitivity badges', () => {
  it('renders a pii badge for a field with sensitivity=pii', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'contacts',
        fields: { email: { type: 'string' } as never },
        indexes: [],
        refs: [],
        described: [
          {
            key: 'email',
            type: 'string',
            optional: false,
            label: 'Email',
            sensitivity: 'pii',
            widget: 'email',
            editable: true,
          },
        ],
      }],
    }
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.text()).toContain('pii')
    expect(wrapper.find('.noydb-schema__badge--pii').exists()).toBe(true)
  })

  it('renders a secret badge for a field with sensitivity=secret', async () => {
    const snap: InspectorSnapshot = {
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
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.text()).toContain('secret')
    expect(wrapper.find('.noydb-schema__badge--secret').exists()).toBe(true)
  })
})

describe('SchemaPane — i18n badge', () => {
  it('renders an i18n badge for a field with i18n present', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'products',
        fields: { name: { type: 'string' } as never },
        indexes: [],
        refs: [],
        described: [
          {
            key: 'name',
            type: 'string',
            optional: false,
            label: 'Name',
            i18n: { locales: ['en', 'th'] },
            widget: 'text',
            editable: true,
          },
        ],
      }],
    }
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.text()).toContain('i18n')
    expect(wrapper.find('.noydb-schema__badge--i18n').exists()).toBe(true)
  })
})

describe('SchemaPane — config strip badges', () => {
  it('renders textIndexes badge when config.textIndexes is set', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'articles',
        fields: { title: { type: 'string' } as never },
        indexes: [],
        refs: [],
        config: { textIndexes: ['title', 'body'] },
      }],
    }
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.find('.noydb-schema__config-strip').exists()).toBe(true)
    expect(wrapper.text()).toContain('text-index')
  })

  it('renders embeddings badge when config.embeddings is set', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'docs',
        fields: { content: { type: 'string' } as never },
        indexes: [],
        refs: [],
        config: { embeddings: { source: 'content', dim: 1536 } },
      }],
    }
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.text()).toContain('embeddings')
  })

  it('renders crdt badge when config.crdt is set', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'notes',
        fields: { body: { type: 'string' } as never },
        indexes: [],
        refs: [],
        config: { crdt: 'lww' },
      }],
    }
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.text()).toContain('crdt:lww')
  })

  it('renders no config strip when collection.config is absent', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'simple',
        fields: { id: { type: 'string' } as never },
        indexes: [],
        refs: [],
      }],
    }
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.find('.noydb-schema__config-strip').exists()).toBe(false)
  })
})

describe('SchemaPane — described fields', () => {
  it('shows field label from described, not raw key, when described is present', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'invoices',
        fields: { amount: { type: 'number' } as never },
        indexes: [],
        refs: [],
        described: [
          {
            key: 'amount',
            type: 'number',
            optional: false,
            label: 'Invoice Amount',
            money: { mode: 'fixed', currency: 'THB' },
            widget: 'money',
            editable: true,
          },
        ],
      }],
    }
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.text()).toContain('Invoice Amount')
    expect(wrapper.text()).toContain('THB')
  })

  it('renders read-only badge for editable:false fields', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'invoices',
        fields: { id: { type: 'string' } as never },
        indexes: [],
        refs: [],
        described: [
          {
            key: 'id',
            type: 'string',
            optional: false,
            label: 'ID',
            widget: 'text',
            editable: false,
          },
        ],
      }],
    }
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.find('.noydb-schema__badge--readonly').exists()).toBe(true)
    expect(wrapper.text()).toContain('read-only')
  })

  it('falls back to raw fields when described is absent', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'invoices',
        fields: { id: { type: 'string' } as never, amount: { type: 'number' } as never },
        indexes: [],
        refs: [],
      }],
    }
    const wrapper = await mountWithSnap(snap)
    // raw keys appear in the fallback rows
    expect(wrapper.text()).toContain('id')
    expect(wrapper.text()).toContain('amount')
  })
})

describe('VaultSidebar — vault meta label', () => {
  it('shows vault meta label when snapshot.meta.label is set', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'orders',
        fields: { id: { type: 'string' } as never },
        indexes: [],
        refs: [],
      }],
      meta: { label: 'Acme DB', description: 'The Acme production vault' },
    }
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.text()).toContain('Acme DB')
  })

  it('falls back to vault id when snapshot.meta is absent', async () => {
    const snap: InspectorSnapshot = {
      vault: 'testvault',
      collections: [{
        name: 'orders',
        fields: { id: { type: 'string' } as never },
        indexes: [],
        refs: [],
      }],
    }
    const wrapper = await mountWithSnap(snap)
    expect(wrapper.text()).toContain('testvault')
  })
})
