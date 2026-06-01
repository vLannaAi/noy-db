# Multi-tab coordination (#228) — design

**Status:** decomposition + sub-slice (a) design · **Date:** 2026-06-01 · **Issue:** #228 · **Epic:** hub coordination

Same-device, multi-tab coordination. Scoped to **browsers** — Web Locks (role election) + BroadcastChannel (presence/propagation), both same-origin. Cross-device is the sync engine's job, explicitly out of scope (per the issue's note). Opt-in and graceful no-op where those APIs are absent.

## Sub-slice decomposition

| Sub-slice | What | Builds on |
|---|---|---|
| **(a) presence + tab roles** | primary/secondary election + active-tab presence | this doc |
| (b) cross-tab write propagation | primary broadcasts committed write diffs; secondaries apply to their in-memory view | (a) + #227 write-queue / #230 hooks |
| (c) conflict detection | `WriteConflict` on `_v`-baseline divergence between tabs | (a) + (b) |

Build order a → b → c. This doc details **(a)**; (b)/(c) get their own specs.

---

# Sub-slice (a): tab roles + presence

**Goal:** Elect one primary tab (owns the write lock; others are secondary and re-elect when it closes) and publish a presence heartbeat so the app can see active tabs.

## API

Opt-in, returns a disposer (browser-only; no-op when Web Locks / BroadcastChannel are unavailable and nothing is injected):

```ts
db.enableTabCoordination(opts?: TabCoordinationOptions): { dispose(): void }

interface TabCoordinationOptions {
  readonly lockManager?: MinimalLockManager  // default: navigator.locks (browser)
  readonly channel?: PeerChannel             // default: tabsChannel() (BroadcastChannel)
  readonly tabId?: string                    // default: a fresh ULID
  readonly lockName?: string                 // default: 'noydb:tab-primary'
  readonly heartbeatMs?: number              // default: 2000
  readonly staleMs?: number                  // default: 6000
}

// framework-agnostic getters/emitters (in-vue wraps into refs later)
db.tabRole: TabRole                                  // 'primary' | 'secondary' | 'unknown'
db.onTabRoleChange(fn: (role: TabRole) => void): Unsubscribe
db.activeTabs(): TabPresence[]
db.onActiveTabsChange(fn: (tabs: TabPresence[]) => void): Unsubscribe

type TabRole = 'primary' | 'secondary' | 'unknown'
interface TabPresence { readonly tabId: string; readonly lastSeen: number; readonly role: TabRole }
```

`MinimalLockManager` + `PeerChannel` are reused from `@noy-db/by-peer` (and `tabsChannel`/`isTabsChannelAvailable` from `@noy-db/by-tabs`).

## Architecture

A `TabCoordinator` (new, in hub core — small, browser-gated, lazily constructed by `enableTabCoordination`):

- **Election (Web Locks).** Issues `lockManager.request(lockName, { mode: 'exclusive', signal }, cb)`. Set `role = 'secondary'` immediately after issuing (we either hold it imminently or are queued); when `cb` runs (lock acquired) set `role = 'primary'` and hold until dispose (the cb returns a promise resolved by `dispose()`). On `dispose()` before acquisition, the `AbortSignal` cancels the queued request. When a primary disposes/closes, its lock releases → the next queued tab's `cb` runs → it transitions to primary (emits `onTabRoleChange`). Mirrors `by-peer`'s `servePeerStore` leader-election, but standalone (no RPC).
- **Presence (channel).** On a `heartbeatMs` interval, broadcast `{ kind: 'tab-presence', tabId, lastSeen: now, role }`. On receiving a peer heartbeat, upsert it; `activeTabs()` = self + peers with `lastSeen >= now - staleMs`, sorted by `tabId`. Broadcast immediately on role change too (so the set reflects promotion fast). Emit `onActiveTabsChange` when the active set changes.
- **Hub surface.** `db.tabRole`/`activeTabs()` are getters reading the coordinator (or defaults `'unknown'`/`[]` when not enabled); `onTabRoleChange`/`onActiveTabsChange` are emitters. Enabling twice is idempotent (returns the same disposer / no-ops).
- **No-op path.** If `opts.lockManager` is absent AND `navigator.locks` is undefined (Node/SSR), and/or no channel + `!isTabsChannelAvailable()`: `enableTabCoordination` returns a disposer but the coordinator stays inert (`role` 'unknown', `activeTabs()` []). This keeps server/test code that calls it harmless.

## Determinism / testing

In-process N-tab harness: N coordinators sharing **one stub `MinimalLockManager`** (FIFO exclusive queue, mirrors `by-peer`'s `createMockLocks`) + an in-memory **broadcast bus** of `PeerChannel`s (a tiny test helper: send → all other tabs receive). Heartbeats driven by an injected `now` + explicit `_beat()`/`_collect()` calls (no real timers). Assert:
- First coordinator to acquire the lock = `primary`; the rest = `secondary`.
- Disposing the primary promotes exactly one secondary to `primary` (role-change emitted).
- Presence: each tab sees the others in `activeTabs()`; a tab whose `lastSeen` is older than `staleMs` drops out.
- No-op path: with no lock manager + no channel, `enableTabCoordination()` returns a disposer, `tabRole` stays `'unknown'`, `activeTabs()` is `[]`.

## Error handling / lifecycle

- `dispose()` releases the lock (abort or resolve the held cb), stops the heartbeat timer, and unsubscribes the channel — idempotent.
- A channel `close` event marks the coordinator inert (role 'unknown').
- Enabling is **opt-in**; hubs that never call `enableTabCoordination()` start no timers/locks (existing suite untouched).

## Scope

**In (a):** election (primary/secondary + re-election), presence (activeTabs + heartbeat), the hub getters/emitters, opt-in enable + disposer, no-op path.

**Out (later sub-slices / deferred):** cross-tab write-diff propagation → (b); `WriteConflict` detection → (c); the Vue `ref` wrappers (`useTabRole`/`useActiveTabs`) → a thin `in-vue` add after (a) lands; SharedWorker-based ordering (the issue floats it as an alternative — not pursued).

## Success criteria

1. Exactly one `primary` among N tabs; others `secondary`; disposing the primary promotes one secondary (role-change fired).
2. `activeTabs()` lists live tabs with `{tabId, lastSeen, role}`; stale tabs (no heartbeat within `staleMs`) drop out.
3. `enableTabCoordination()` is opt-in, returns a working `dispose()`, and is a safe no-op outside browsers (no throw, role `'unknown'`).
4. Hubs that don't enable it incur zero new timers/locks — existing suite unaffected.
