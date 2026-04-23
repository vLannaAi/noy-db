# Issue #163 — feat(core): ephemeral routing — runtime store override for shared devices and restricted networks

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-10
- **Milestone:** v0.12.0
- **Labels:** type: feature, priority: medium, area: core, area: adapters

---

## Target package

\`@noy-db/hub\`

## Spawned from

v0.12 implementation session — \`routeStore\` (#162) provides static routing at construction time. Two real-world scenarios require **runtime** routing changes without recreating the noy-db instance.

## Problem

### Scenario A — Shared / public computer (kiosk, hotel business center, colleague's laptop)

An accountant logs into the firm's web app from a shared computer. The app normally uses \`to-browser-idb\` for offline-first local storage. On a shared device, **no data must persist after the session ends** — not in IndexedDB, not in localStorage, not on the filesystem.

Today, the only option is to \`createNoydb({ store: memory() })\` from the start. But the app doesn't know it's a shared device until the user tells it (e.g. a "Private session" toggle on the login screen). By then, the noy-db instance is already created with the IDB store.

The developer needs: **"replace the local store with in-memory for this session, without re-initializing the entire app."**

### Scenario B — Restricted network (China, air-gapped site, flaky hotel Wi-Fi)

A user travels to China. The app normally syncs to DynamoDB + backs up to Google Drive. Behind the Great Firewall, both are unreachable. The app detects this (ping fails, \`sync:backup-error\` events fire repeatedly). The developer wants to:

1. **Suspend** the DynamoDB sync target — stop attempting pushes that will fail.
2. **Replace** the Google Drive backup target with a local file dump — keep creating backups but to a reachable destination.
3. **Resume** the original configuration when connectivity returns.

The developer handles the detection and decision in userland. But noy-db must support swapping routes at runtime.

### Scenario C — Regulatory mode switch

A user switches between "production" and "audit" modes. In audit mode, all writes are additionally mirrored to a tamper-evident store (append-only S3 with Object Lock). The developer toggles this at runtime based on a UI control.

### Common thread

All three scenarios share the same requirement: **mutate the store routing configuration after \`createNoydb()\` without losing the in-memory state (open vaults, cached records, keyring material, dirty tracking).**

## Proposed solution: \`routeStore.override()\`

Extend \`RoutedNoydbStore\` (from #162) with runtime override methods:

\`\`\`ts
interface RoutedNoydbStore extends NoydbStore {
  compact(vault: string): Promise<number>

  /**
   * Override a named route at runtime. The override persists until
   * \`clearOverride()\` is called or the instance is closed.
   *
   * Does NOT migrate existing data — the new store starts empty (or
   * pre-populated by the caller). In-flight operations complete on
   * the original store; new operations use the override.
   */
  override(route: OverrideTarget, store: NoydbStore): void

  /**
   * Clear a runtime override, reverting to the original store.
   */
  clearOverride(route: OverrideTarget): void

  /**
   * Suspend a route entirely. Operations to suspended stores are
   * silently dropped (puts become no-ops, gets return null, lists
   * return []). Dirty tracking continues — when the route is resumed,
   * pending writes can be flushed.
   */
  suspend(route: OverrideTarget): void

  /**
   * Resume a previously suspended route.
   */
  resume(route: OverrideTarget): void

  /**
   * Snapshot the current override/suspend state for diagnostics.
   */
  routeStatus(): RouteStatus
}

type OverrideTarget =
  | 'default'      // the primary store
  | 'blobs'        // the blob chunk store
  | 'cold'         // the age-tiered cold store
  | string         // a named collection route or vault route
\`\`\`

### Usage: Scenario A — shared device

\`\`\`ts
import { routeStore } from '@noy-db/hub'
import { browserIdbStore } from '@noy-db/to-browser-idb'
import { memory } from '@noy-db/to-memory'

const store = routeStore({
  default: browserIdbStore({ prefix: 'myapp' }),
  blobs: browserIdbStore({ prefix: 'myapp-blobs' }),
})

const db = await createNoydb({ store, user, secret })

// User checks "Private session" on login screen
if (isSharedDevice) {
  store.override('default', memory())
  store.override('blobs', memory())
  // All subsequent operations go to in-memory stores.
  // When the tab closes, everything is gone. No cleanup needed.
}
\`\`\`

### Usage: Scenario B — restricted network

\`\`\`ts
// App detects China / unreachable AWS
if (!await db.ping('cloud-vault')) {
  // Suspend DynamoDB sync — stops push attempts
  store.suspend('default')
  // Replace Google Drive backup with local file dump
  store.override('backup-drive', jsonFile({ dir: '/tmp/noydb-offline' }))
}

// Later: connectivity restored
store.resume('default')
store.clearOverride('backup-drive')
// Dirty writes accumulated during suspension are now flushed
\`\`\`

### Usage: Scenario C — audit mode toggle

\`\`\`ts
function enableAuditMode() {
  store.override('audit-mirror', s3ObjectLock({ bucket: 'audit-trail' }))
}

function disableAuditMode() {
  store.clearOverride('audit-mirror')
}
\`\`\`

## Implementation design

### Override resolution

The existing \`storeFor(vault, collection)\` resolution chain (from #162) gains a pre-check:

\`\`\`
1. Is the resolved route suspended?      → return NullStore (no-ops)
2. Is there a runtime override for it?   → return the override store
3. (existing) vaultRoutes → routes → blobs → age → default
\`\`\`

### NullStore (suspended route sink)

A minimal \`NoydbStore\` that silently accepts all operations:

\`\`\`ts
const NULL_STORE: NoydbStore = {
  name: 'suspended',
  async get()     { return null },
  async put()     {},
  async delete()  {},
  async list()    { return [] },
  async loadAll() { return {} },
  async saveAll() {},
}
\`\`\`

### State tracking

\`\`\`ts
interface RouteStatus {
  overrides: Record<string, string>   // route → override store name
  suspended: string[]                  // list of suspended routes
}
\`\`\`

### What does NOT change on override

- **In-memory state is preserved.** Open vaults, cached records, keyring material, DEKs — all stay in memory. The override only affects where *new* store I/O goes.
- **Dirty tracking continues.** If a sync target is suspended, its dirty log accumulates. When resumed, \`push()\` flushes everything.
- **Encryption is unchanged.** The override store receives the same ciphertext as the original.

### What the developer must handle (userland)

- **Detecting** when to override (shared device toggle, network check, audit mode).
- **Pre-populating** the override store if needed (e.g. pulling data into memory before switching).
- **Cleaning up** temporary stores (the in-memory store is GC'd on tab close; the temp file directory needs explicit cleanup).
- **Communicating** to the user that they're in a restricted mode (UI indicator).

## Scope

- [ ] \`override(route, store)\` on \`RoutedNoydbStore\`
- [ ] \`clearOverride(route)\` on \`RoutedNoydbStore\`
- [ ] \`suspend(route)\` / \`resume(route)\` on \`RoutedNoydbStore\`
- [ ] \`routeStatus()\` for diagnostics
- [ ] \`NullStore\` internal implementation for suspended routes
- [ ] Override resolution integrated into \`storeFor()\`
- [ ] Tests: override lifecycle, suspend/resume, dirty accumulation during suspension, clearOverride reverts, multiple concurrent overrides
- [ ] Changeset

## Borderline cases

| # | Case | Resolution |
|---|------|-----------|
| B1 | Override while operations are in-flight | In-flight operations complete on the original store. The override takes effect for the *next* call. No locking needed — JS is single-threaded for the synchronous \`override()\` call. |
| B2 | Override the default store while vaults are open | Vault cache stays in memory. New \`get()\`/\`put()\` calls go to the override. \`loadAll()\` on the override returns empty — the caller should pre-populate or accept a cold start. |
| B3 | Suspend a store mid-sync | \`push()\` calls to a suspended store become no-ops. Dirty entries remain in the log. When resumed, the next \`push()\` sends them all. |
| B4 | Override + age tiering | If \`default\` is overridden, the cold fallback still works (cold store is a separate route). If \`cold\` is overridden, age-tiered reads use the override. |
| B5 | Override + size-tiered blobs | Override \`blobs\` replaces the entire blob routing (both small and large). For finer control, override \`blobs.small\` or \`blobs.large\` individually. |
| B6 | \`saveAll\` / \`loadAll\` with overrides | Uses the *currently active* store for each route (override if present, original if not). The caller gets a consistent view of whatever stores are active. |
| B7 | Clear override while data exists in the override store | Data in the override store becomes unreachable (it was temporary). The original store resumes. The caller is responsible for migrating data back if needed (e.g. \`loadAll\` from override → \`saveAll\` to original before clearing). |
| B8 | Tab crash during memory-only session | Data is lost — that's the point of ephemeral mode. The developer should warn the user ("unsaved changes will be lost if you close this tab"). |
| B9 | Multiple overrides on the same route | Last override wins. Each \`override()\` call replaces the previous one. |
| B10 | Suspend + override on the same route | Suspend takes precedence. A suspended route is a no-op regardless of overrides. Call \`resume()\` first, then the override becomes active. |

## Invariant compliance

- [x] Adapters never see plaintext — override stores receive the same ciphertext
- [x] KEK/DEK handling unchanged — keys stay in memory regardless of store routing
- [x] Zero new crypto dependencies
- [x] 6-method store contract preserved — \`NullStore\` and override stores are standard \`NoydbStore\` instances

## Related

- #162 — \`routeStore\` static routing (this extends it)
- #158 — \`SyncTarget[]\` multi-backend topology (sync targets could also be overridden)
- #101 — \`syncPolicy\` scheduling (suspended targets should pause their scheduler)

v0.12.
