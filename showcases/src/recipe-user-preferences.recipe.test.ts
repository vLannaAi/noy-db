/**
 * Recipe — User preferences (the reference UserEnvelope shape).
 *
 * The runnable verification of `docs/recipes/user-preferences.md`.
 * This file IS the source-of-truth code shown in the doc — if you
 * change one, change the other.
 *
 * Goal: demonstrate the **reference** shape for the per-principal
 * `_users/<keyringId>` envelope. The shape lives at the **app layer**
 * — hub does NOT import or reserve any of these field names. Apps
 * copy this pattern, modify it, or replace it. Hub commits only to
 * `userId === keyringId` and the storage location.
 *
 * The reference shape:
 *
 *   - `profile`        — identity-adjacent (rare writes)
 *     · displayName    : string  — render across team UIs
 *     · avatarRef      : string  — blob-set ref (stored in vault)
 *     · locale         : string  — BCP 47
 *     · timeZone       : string  — IANA
 *
 *   - `preferences`    — UI / app-config (frequent writes)
 *     · theme          : 'light' | 'dark' | 'system'
 *     · locale         : string  — overrides profile.locale for UI
 *
 *   - `app`            — free-form annex; opaque to hub
 *
 * Device-local state pattern:
 *   `lastOpenedCollectionId`, `tableColumnWidths`, scroll position
 *   live in **localStorage at the app layer**, NOT in the vault.
 *   Why: anything stored in the vault syncs across devices; device-
 *   local state is by definition NOT cross-device. If you want it
 *   cross-device, sync it (via the vault). If you don't, keep it
 *   in localStorage.
 *
 * Vue + Pinia integration: `vault.user.live(keyringId)` returns a
 * reactive handle. The recipe doc shows the full Vue setup; this
 * test exercises the API surface only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createNoydb, type Noydb, type NoydbStore } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

// ─── App-defined reference shape ─────────────────────────────────────────
//
// This interface lives in the APP, not in the hub. Apps own the schema.

interface UserShape {
  profile?: {
    displayName?: string
    avatarRef?: string  // ref into the vault's blob-set; not a URL
    locale?: string     // BCP 47
    timeZone?: string   // IANA
  }
  preferences?: {
    theme?: 'light' | 'dark' | 'system'
    locale?: string     // UI override; falls back to profile.locale
  }
  app?: {
    // Per-app extensions. Opaque to hub.
    signature?: string
    perClientCurrency?: Record<string, string>
  }
}

// ─── Device-local state — stored OUTSIDE the vault ───────────────────────
//
// Mock localStorage for the test. In a real app this is `window.localStorage`.

interface DeviceLocalState {
  lastOpenedCollectionId?: string
  tableColumnWidths?: Record<string, number>
}

class MockLocalStorage {
  private state: DeviceLocalState = {}
  load(): DeviceLocalState { return { ...this.state } }
  save(patch: Partial<DeviceLocalState>): void {
    this.state = { ...this.state, ...patch }
  }
}

const PASSPHRASE = 'correct-horse-battery-staple-printer-toaster'

describe('Recipe — User preferences (reference shape)', () => {
  let db: Noydb
  let store: NoydbStore
  let device: MockLocalStorage

  beforeEach(async () => {
    store = memory()
    device = new MockLocalStorage()
    db = await createNoydb({ store, user: 'me', secret: PASSPHRASE })
  })

  afterEach(() => { db.close() })

  it('reads + writes profile + preferences via the typed shape', async () => {
    const vault = await db.openVault('app')

    // First write: full initial profile + preferences.
    await vault.user.updateMe<UserShape>({
      profile: {
        displayName: 'Vicio',
        locale: 'it-IT',
        timeZone: 'Europe/Rome',
      },
      preferences: {
        theme: 'dark',
        locale: 'en-US', // UI override
      },
    })

    // Read back via the typed reader.
    const me = await vault.user.me<UserShape>()
    expect(me?.data.profile?.displayName).toBe('Vicio')
    expect(me?.data.profile?.timeZone).toBe('Europe/Rome')
    expect(me?.data.preferences?.theme).toBe('dark')
    expect(me?.data.preferences?.locale).toBe('en-US')
  })

  it('updateMe deep-merges — partial patches preserve unmentioned fields', async () => {
    const vault = await db.openVault('app')
    await vault.user.updateMe<UserShape>({
      profile: { displayName: 'V', locale: 'it-IT' },
      preferences: { theme: 'dark' },
    })

    // User toggles theme — preferences.locale and profile.* stay intact.
    await vault.user.updateMe<UserShape>({
      preferences: { theme: 'light' },
    })

    const me = await vault.user.me<UserShape>()
    expect(me?.data.preferences?.theme).toBe('light')
    expect(me?.data.profile?.displayName).toBe('V') // preserved
    expect(me?.data.profile?.locale).toBe('it-IT')  // preserved
  })

  it('app annex carries domain-specific fields, opaque to hub', async () => {
    const vault = await db.openVault('app')
    await vault.user.updateMe<UserShape>({
      profile: { displayName: 'Accountant Alice' },
      app: {
        signature: 'A. Alice — Studio Lanna',
        perClientCurrency: {
          'client-acme': 'EUR',
          'client-foo': 'USD',
          'client-bar': 'THB',
        },
      },
    })
    const me = await vault.user.me<UserShape>()
    expect(me?.data.app?.perClientCurrency?.['client-bar']).toBe('THB')
  })

  it('device-local state lives in localStorage, NOT in the vault', async () => {
    const vault = await db.openVault('app')

    // App writes preferences to the vault (cross-device sync).
    await vault.user.updateMe<UserShape>({
      preferences: { theme: 'dark' },
    })

    // App writes device-local UI state to localStorage (NOT to vault).
    device.save({
      lastOpenedCollectionId: 'invoices',
      tableColumnWidths: { date: 100, amount: 80, client: 200 },
    })

    // Vault carries cross-device state.
    const me = await vault.user.me<UserShape>()
    expect(me?.data.preferences?.theme).toBe('dark')

    // localStorage carries this-device state.
    const local = device.load()
    expect(local.lastOpenedCollectionId).toBe('invoices')
    expect(local.tableColumnWidths?.date).toBe(100)

    // Verify: device-local fields are NOT in the vault envelope.
    expect((me?.data as UserShape & { lastOpenedCollectionId?: string }).lastOpenedCollectionId)
      .toBeUndefined()
  })

  it('reactive: vault.user.live(self) reflects local writes', async () => {
    const vault = await db.openVault('app')
    const live = vault.user.live<UserShape>('me')

    expect(live.current()).toBeNull()

    await vault.user.updateMe<UserShape>({
      profile: { displayName: 'A' },
    })
    expect(live.current()?.data.profile?.displayName).toBe('A')

    await vault.user.updateMe<UserShape>({
      profile: { displayName: 'B' },
    })
    expect(live.current()?.data.profile?.displayName).toBe('B')

    live.stop()
  })

  it('presence pattern: app supplies displayName from its own user envelope', async () => {
    // The pattern: when announcing presence on a collection, the app
    // sources displayName from `vault.user.me<UserShape>()` and includes
    // it in the presence payload `P`. Hub does NOT introspect the
    // envelope (consistent with the (d) free-form schema decision).
    //
    // This recipe documents the call shape; the actual presence wiring
    // happens at the collection level (vault.collection('foo').presence()).
    const vault = await db.openVault('app')
    await vault.user.updateMe<UserShape>({
      profile: { displayName: 'Vicio' },
    })

    const me = await vault.user.me<UserShape>()
    const presencePayload = {
      displayName: me?.data.profile?.displayName,
      editingRecordId: 'invoice-42',
    }

    // The app then calls collection.presence().update(presencePayload).
    // Subscribers receive PresencePeer<typeof presencePayload> and
    // render `peer.payload.displayName`. Hub stays payload-agnostic.
    expect(presencePayload.displayName).toBe('Vicio')
    expect(presencePayload.editingRecordId).toBe('invoice-42')
  })
})

/**
 * Sequence diagram (own-write propagation):
 *
 * ```mermaid
 * sequenceDiagram
 *   participant DevA as Writer device A
 *   participant DevB as Writer device B
 *   participant Sync as Team sync engine
 *   participant Mate as Teammate device
 *
 *   DevA->>DevA: vault.user.updateMe(patch)
 *   DevA->>Sync: write to _users/<self>
 *   DevA-->>DevB: presence-channel fast path (own devices)
 *   DevB-->>DevB: subscribers fire, UI re-renders
 *   Sync->>Mate: normal sync diff (next tick)
 *   Mate-->>Mate: subscribers fire on Mate's vault.user.* path
 * ```
 *
 * Note: in v1 hub, the presence-channel fast path is a documentation
 * of intent — the in-process subscribe/live mechanism fires only on
 * local writes. Cross-instance updates flow through the team/sync
 * engine; subscribers there pick up changes via re-loaded reads.
 */
