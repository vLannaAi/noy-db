# Tab coordination — roles + presence (#228 sub-slice a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `db.enableTabCoordination()` elects a primary tab (Web Locks) and publishes a presence heartbeat (BroadcastChannel), exposing `db.tabRole` / `db.activeTabs()` + change emitters — opt-in, browser-only, graceful no-op elsewhere.

**Architecture:** A self-contained `TabCoordinator` in hub core. It takes a `TabLockManager` (default `navigator.locks`) and a `TabChannel` (default: an inline `BroadcastChannel` wrapper) — both **hub-local minimal interfaces** (structurally compatible with `@noy-db/by-peer`'s `MinimalLockManager` / `PeerChannel`, but NOT imported, to avoid a circular dep since those packages depend on hub). Election: hold an exclusive lock = primary; queued = secondary; re-elect on release. Presence: heartbeat `{tabId,lastSeen,role}` over the channel, stale-filtered.

**Tech Stack:** TypeScript, Vitest. Package: `packages/hub`. Browser APIs (`navigator.locks`, `BroadcastChannel`) accessed via `globalThis` with feature-detection. Own PR through CI.

**Spec:** `docs/superpowers/specs/2026-06-01-228-tab-coordination-design.md` (sub-slice a). Issue #228.

---

## File structure

- **Create** `packages/hub/src/tab-coordination.ts` — `TabRole`/`TabPresence`/`TabLockManager`/`TabChannel`/`TabCoordinationOptions` types + `TabCoordinator` class + `defaultLockManager()`/`defaultChannel()` browser helpers.
- **Modify** `packages/hub/src/noydb.ts` — `enableTabCoordination()` + `tabRole`/`activeTabs()`/`onTabRoleChange`/`onActiveTabsChange` + cleanup on `close`.
- **Modify** `packages/hub/src/index.ts` — export the public types.
- **Create** `packages/hub/__tests__/tab-coordination.test.ts` (multi-tab, deterministic) + a small `noydb` no-op test.

---

## Task 1: `TabCoordinator` + types

**Files:** Create `packages/hub/src/tab-coordination.ts`; Test `packages/hub/__tests__/tab-coordination.test.ts`

- [ ] **Step 1: Write the failing test** (N coordinators sharing a stub lock manager + an in-memory broadcast bus; explicit `now` + `_beat()`)

```ts
import { describe, expect, it, vi } from 'vitest'
import { TabCoordinator, type TabLockManager, type TabChannel } from '../src/tab-coordination.js'

/** FIFO exclusive lock manager (mirrors by-peer's createMockLocks). */
function mockLocks(): TabLockManager {
  const held = new Set<string>()
  const queues = new Map<string, Array<() => void>>()
  async function pump(name: string) {
    if (held.has(name)) return
    const q = queues.get(name) ?? []
    const next = q.shift()
    if (!next) return
    held.add(name)
    next()
  }
  return {
    request(name, _opts, cb) {
      return new Promise((resolve, reject) => {
        const run = () => {
          void Promise.resolve()
            .then(() => cb(undefined))
            .then((v) => { held.delete(name); void pump(name); resolve(v as never) },
                  (e) => { held.delete(name); void pump(name); reject(e) })
        }
        const q = queues.get(name) ?? []
        q.push(run); queues.set(name, q)
        // abort: drop from queue if still waiting
        _opts.signal?.addEventListener('abort', () => {
          const qq = queues.get(name) ?? []
          const i = qq.indexOf(run); if (i >= 0) qq.splice(i, 1)
          reject(new Error('aborted'))
        })
        void pump(name)
      })
    },
  }
}

/** In-memory broadcast bus: each channel's send() reaches all OTHER channels. */
function makeBus(n: number): TabChannel[] {
  const listeners: Array<((p: string) => void) | null> = []
  const chans: TabChannel[] = []
  for (let i = 0; i < n; i++) {
    const idx = i
    chans.push({
      isOpen: true,
      send(payload) { for (let j = 0; j < listeners.length; j++) if (j !== idx && listeners[j]) queueMicrotask(() => listeners[j]!(payload)) },
      on(event, l) { if (event === 'message') { listeners[idx] = l as (p: string) => void; return () => { listeners[idx] = null } } return () => {} },
      close() { listeners[idx] = null },
    })
  }
  return chans
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function mkCoordinator(lockManager: TabLockManager, channel: TabChannel, tabId: string, now: () => number) {
  return new TabCoordinator({ lockManager, channel, tabId, heartbeatMs: 1_000_000, staleMs: 500, now })
}

describe('TabCoordinator', () => {
  it('elects exactly one primary; the rest are secondary', async () => {
    const locks = mockLocks()
    const bus = makeBus(3)
    let t = 1000
    const tabs = bus.map((ch, i) => mkCoordinator(locks, ch, `tab${i}`, () => t))
    tabs.forEach((c) => c.start())
    await flush()
    const roles = tabs.map((c) => c.role).sort()
    expect(roles.filter((r) => r === 'primary')).toHaveLength(1)
    expect(roles.filter((r) => r === 'secondary')).toHaveLength(2)
  })

  it('promotes a secondary when the primary disposes', async () => {
    const locks = mockLocks()
    const bus = makeBus(2)
    let t = 1000
    const tabs = bus.map((ch, i) => mkCoordinator(locks, ch, `tab${i}`, () => t))
    tabs.forEach((c) => c.start())
    await flush()
    const primary = tabs.find((c) => c.role === 'primary')!
    const secondary = tabs.find((c) => c.role === 'secondary')!
    primary.dispose()
    await flush()
    expect(secondary.role).toBe('primary')
  })

  it('presence: a tab sees the others; stale tabs drop out', async () => {
    const locks = mockLocks()
    const bus = makeBus(2)
    let t = 1000
    const [a, b] = bus.map((ch, i) => mkCoordinator(locks, ch, `tab${i}`, () => t))
    a!.start(); b!.start()
    await flush()
    a!._beat(); b!._beat()
    await flush()
    expect(a!.activeTabs().map((p) => p.tabId).sort()).toEqual(['tab0', 'tab1'])
    t += 10_000 // advance past staleMs; b never beats again
    a!._beat()
    await flush()
    expect(a!.activeTabs().map((p) => p.tabId)).toEqual(['tab0'])
  })

  it('emits onTabRoleChange', async () => {
    const locks = mockLocks()
    const bus = makeBus(1)
    let t = 1000
    const c = mkCoordinator(locks, bus[0]!, 'tab0', () => t)
    const seen: string[] = []
    c.onTabRoleChange((r) => seen.push(r))
    c.start()
    await flush()
    expect(seen).toContain('primary')
  })

  it('no-op when no lock manager and no channel', async () => {
    const c = new TabCoordinator({ heartbeatMs: 1_000_000, staleMs: 500, now: () => 0 })
    c.start()
    await flush()
    expect(c.role).toBe('unknown')
    expect(c.activeTabs()).toEqual([])
    c.dispose()
  })
})
```

- [ ] **Step 2: Run → fail** (`cd packages/hub && npx vitest run __tests__/tab-coordination.test.ts`)

- [ ] **Step 3: Implement** `tab-coordination.ts`

```ts
/**
 * Multi-tab coordination (#228a): primary/secondary election (Web Locks)
 * + presence heartbeat (BroadcastChannel). Browser-only; opt-in; no-op
 * when the APIs are absent. The lock/channel interfaces are hub-local
 * (structurally compatible with @noy-db/by-peer + @noy-db/by-tabs, but
 * not imported — those packages depend on hub).
 */
export type TabRole = 'primary' | 'secondary' | 'unknown'
export interface TabPresence { readonly tabId: string; readonly lastSeen: number; readonly role: TabRole }
export type Unsubscribe = () => void

/** Structural subset of the Web Locks API / by-peer's MinimalLockManager. */
export interface TabLockManager {
  request<T>(name: string, options: { mode?: 'exclusive' | 'shared'; signal?: AbortSignal }, callback: (lock: unknown) => Promise<T>): Promise<T>
}

/** Structural subset of by-peer's PeerChannel / a BroadcastChannel wrapper. */
export interface TabChannel {
  send(payload: string): void
  on(event: 'message', listener: (payload: string) => void): Unsubscribe
  on(event: 'close', listener: () => void): Unsubscribe
  close(): void
  readonly isOpen: boolean
}

export interface TabCoordinationOptions {
  readonly lockManager?: TabLockManager
  readonly channel?: TabChannel
  readonly tabId?: string
  readonly lockName?: string
  readonly heartbeatMs?: number
  readonly staleMs?: number
  readonly now?: () => number
}

interface PresenceMsg { readonly kind: 'tab-presence'; readonly tabId: string; readonly lastSeen: number; readonly role: TabRole }

export class TabCoordinator {
  readonly tabId: string
  role: TabRole = 'unknown'
  readonly #lockManager: TabLockManager | undefined
  readonly #channel: TabChannel | undefined
  readonly #lockName: string
  readonly #heartbeatMs: number
  readonly #staleMs: number
  readonly #now: () => number
  readonly #peers = new Map<string, TabPresence>()
  readonly #roleHandlers = new Set<(r: TabRole) => void>()
  readonly #tabsHandlers = new Set<(t: TabPresence[]) => void>()
  #ac: AbortController | undefined
  #releaseLock: (() => void) | undefined
  #unsub: Unsubscribe | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #disposed = false

  constructor(opts: TabCoordinationOptions = {}) {
    this.tabId = opts.tabId ?? `tab-${Math.trunc((opts.now ?? (() => 0))())}-${cheapRand()}`
    this.#lockManager = opts.lockManager
    this.#channel = opts.channel
    this.#lockName = opts.lockName ?? 'noydb:tab-primary'
    this.#heartbeatMs = opts.heartbeatMs ?? 2_000
    this.#staleMs = opts.staleMs ?? 6_000
    this.#now = opts.now ?? (() => Date.now())
  }

  start(): void {
    if (this.#disposed) return
    if (this.#channel) {
      this.#unsub = this.#channel.on('message', (p) => this.#onMessage(p))
      this.#beat()
      this.#timer = setInterval(() => this.#beat(), this.#heartbeatMs)
      const t = this.#timer as unknown as { unref?: () => void }
      if (typeof t.unref === 'function') t.unref()
    }
    if (this.#lockManager) {
      this.#ac = new AbortController()
      this.#setRole('secondary')
      void this.#lockManager
        .request(this.#lockName, { mode: 'exclusive', signal: this.#ac.signal }, () => {
          this.#setRole('primary')
          return new Promise<void>((resolve) => { this.#releaseLock = resolve })
        })
        .catch(() => { /* aborted on dispose */ })
    }
  }

  activeTabs(): TabPresence[] {
    const cutoff = this.#now() - this.#staleMs
    const self: TabPresence = { tabId: this.tabId, lastSeen: this.#now(), role: this.role }
    const out = [self, ...[...this.#peers.values()].filter((p) => p.lastSeen >= cutoff)]
    return out.sort((a, b) => a.tabId.localeCompare(b.tabId))
  }

  onTabRoleChange(fn: (r: TabRole) => void): Unsubscribe { this.#roleHandlers.add(fn); return () => this.#roleHandlers.delete(fn) }
  onActiveTabsChange(fn: (t: TabPresence[]) => void): Unsubscribe { this.#tabsHandlers.add(fn); return () => this.#tabsHandlers.delete(fn) }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#releaseLock?.()
    this.#ac?.abort()
    if (this.#timer) clearInterval(this.#timer)
    this.#unsub?.()
    this.#setRole('unknown')
  }

  /** @internal test seam — broadcast one heartbeat now. */
  _beat(): void { this.#beat() }

  #beat(): void {
    if (!this.#channel || !this.#channel.isOpen) return
    const msg: PresenceMsg = { kind: 'tab-presence', tabId: this.tabId, lastSeen: this.#now(), role: this.role }
    this.#channel.send(JSON.stringify(msg))
  }

  #onMessage(payload: string): void {
    let msg: unknown
    try { msg = JSON.parse(payload) } catch { return }
    if (!isPresenceMsg(msg) || msg.tabId === this.tabId) return
    this.#peers.set(msg.tabId, { tabId: msg.tabId, lastSeen: msg.lastSeen, role: msg.role })
    this.#emitTabs()
  }

  #setRole(role: TabRole): void {
    if (this.role === role) return
    this.role = role
    for (const h of this.#roleHandlers) h(role)
    this.#beat() // announce promptly
  }

  #emitTabs(): void {
    const tabs = this.activeTabs()
    for (const h of this.#tabsHandlers) h(tabs)
  }
}

function isPresenceMsg(x: unknown): x is PresenceMsg {
  if (x === null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return o['kind'] === 'tab-presence' && typeof o['tabId'] === 'string' && typeof o['lastSeen'] === 'number'
}

function cheapRand(): string {
  // Non-crypto, non-Date id suffix for a default tabId; callers pass a stable tabId in tests.
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  return g.crypto?.randomUUID ? g.crypto.randomUUID().slice(0, 8) : 'anon'
}

/** Browser default lock manager (navigator.locks) or undefined. */
export function defaultLockManager(): TabLockManager | undefined {
  const nav = (globalThis as { navigator?: { locks?: TabLockManager } }).navigator
  return nav?.locks
}

/** Browser default channel: an inline BroadcastChannel wrapper, or undefined. */
export function defaultChannel(name = 'noydb:tabs'): TabChannel | undefined {
  const Bc = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel
  if (!Bc) return undefined
  const bc = new Bc(name)
  const msgListeners = new Set<(p: string) => void>()
  bc.onmessage = (e: MessageEvent) => { for (const l of msgListeners) l(String(e.data)) }
  return {
    isOpen: true,
    send(payload) { bc.postMessage(payload) },
    on(event, listener) {
      if (event === 'message') { const l = listener as (p: string) => void; msgListeners.add(l); return () => msgListeners.delete(l) }
      return () => {}
    },
    close() { msgListeners.clear(); bc.close() },
  }
}
```

(`Math.trunc`/`cheapRand` are fine in library code; only workflow *scripts* forbid `Date.now`/`Math.random` — and tests pass an explicit `tabId`/`now` so determinism holds.)

- [ ] **Step 4: Run → pass** (`cd packages/hub && npx vitest run __tests__/tab-coordination.test.ts`) — 5 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/tab-coordination.ts packages/hub/__tests__/tab-coordination.test.ts
git commit -m "feat(hub): TabCoordinator — Web-Locks election + presence heartbeat (#228)"
```

---

## Task 2: Wire `enableTabCoordination` into Noydb

**Files:** Modify `packages/hub/src/noydb.ts`; Test `packages/hub/__tests__/tab-coordination-noydb.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'
import type { TabLockManager, TabChannel } from '../src/tab-coordination.js'

describe('db.enableTabCoordination (#228)', () => {
  it('no-op outside a browser: returns a disposer; role stays unknown', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'tab-pass-1234' })
    const handle = db.enableTabCoordination() // no navigator.locks / BroadcastChannel in node
    expect(db.tabRole).toBe('unknown')
    expect(db.activeTabs()).toEqual([])
    handle.dispose()
  })

  it('with injected lock manager + channel, becomes primary', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'tab-pass-1234' })
    let resolveCb: (() => void) | undefined
    const locks: TabLockManager = {
      async request(_n, _o, cb) { return cb(undefined) }, // acquire immediately
    }
    const channel: TabChannel = { isOpen: true, send() {}, on() { return () => {} }, close() {} }
    const handle = db.enableTabCoordination({ lockManager: locks, channel, tabId: 't1' })
    await new Promise((r) => setTimeout(r, 0))
    expect(db.tabRole).toBe('primary')
    void resolveCb
    handle.dispose()
  })
})
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement** — in `noydb.ts`:

Import:
```ts
import { TabCoordinator, defaultLockManager, defaultChannel, type TabCoordinationOptions, type TabRole, type TabPresence, type Unsubscribe } from './tab-coordination.js'
```
Field (beside the other coordinators):
```ts
  #tabCoordinator: TabCoordinator | undefined
```
Public API (in the Events section):
```ts
  /**
   * Enable same-device multi-tab coordination (#228): primary/secondary
   * election + presence. Browser-only — a graceful no-op (role 'unknown')
   * when Web Locks / BroadcastChannel are unavailable and nothing is
   * injected. Idempotent; returns a disposer.
   */
  enableTabCoordination(opts: TabCoordinationOptions = {}): { dispose: () => void } {
    if (this.#tabCoordinator) return { dispose: () => this.#disableTabCoordination() }
    const c = new TabCoordinator({
      ...opts,
      lockManager: opts.lockManager ?? defaultLockManager(),
      channel: opts.channel ?? defaultChannel(),
    })
    this.#tabCoordinator = c
    c.start()
    return { dispose: () => this.#disableTabCoordination() }
  }

  #disableTabCoordination(): void {
    this.#tabCoordinator?.dispose()
    this.#tabCoordinator = undefined
  }

  get tabRole(): TabRole { return this.#tabCoordinator?.role ?? 'unknown' }
  activeTabs(): TabPresence[] { return this.#tabCoordinator?.activeTabs() ?? [] }
  onTabRoleChange(fn: (r: TabRole) => void): Unsubscribe { return this.#tabCoordinator?.onTabRoleChange(fn) ?? (() => {}) }
  onActiveTabsChange(fn: (t: TabPresence[]) => void): Unsubscribe { return this.#tabCoordinator?.onActiveTabsChange(fn) ?? (() => {}) }
```
In `close()` (the instance teardown — `grep -n "async close\|close()" src/noydb.ts`), add `this.#disableTabCoordination()` so the lock/heartbeat stop.

- [ ] **Step 4: Run → pass; typecheck**

Run: `cd packages/hub && npx vitest run __tests__/tab-coordination-noydb.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/noydb.ts packages/hub/__tests__/tab-coordination-noydb.test.ts
git commit -m "feat(hub): db.enableTabCoordination + tabRole/activeTabs surface (#228)"
```

---

## Task 3: Export types + features.yaml + final verify

**Files:** Modify `packages/hub/src/index.ts`, `features.yaml`

- [ ] **Step 1: Export public types** (`index.ts`, near the other coordination exports):
```ts
// Multi-tab coordination (#228)
export type { TabRole, TabPresence, TabCoordinationOptions } from './tab-coordination.js'
```

- [ ] **Step 2: features.yaml entry** (mirror `dry-run-transactions`):
```yaml
  - id: tab-coordination
    name: Multi-tab coordination (presence + roles)
    cluster: core
    spec: docs/superpowers/specs/2026-06-01-228-tab-coordination-design.md
    subsystem_doc: docs/superpowers/specs/2026-06-01-228-tab-coordination-design.md
    package: '@noy-db/hub'
    factory: null
    status: preview
    showcases: []
    recipes: []
    playground_pages: []
    diagrams: []
    invariants:
      - 'exactly one primary tab via an exclusive Web Lock; others secondary; re-elects on primary dispose'
      - 'presence heartbeat lists active tabs; stale tabs (no heartbeat within staleMs) drop out'
      - 'opt-in via db.enableTabCoordination(); graceful no-op (role unknown) outside browsers'
    related: [vault-and-collections]
```

- [ ] **Step 3: Validate + full verify**
```bash
cd /Users/vicio/_github/noy-db && node scripts/validate-features.mjs
cd packages/hub && npx vitest run && npx tsc --noEmit && npm run lint
```
Expected: validator PASS; full suite PASS (and vitest exits cleanly — the heartbeat timer is `unref()`'d and only starts when a channel is provided/available, so the existing suite — which never calls `enableTabCoordination` — starts none); typecheck + lint clean.

- [ ] **Step 4: Commit + clean tree**
```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/index.ts features.yaml
git commit -m "chore(hub): export tab-coordination types; register feature (#228)"
git status
```

---

## Self-review checklist (already applied)

- **Spec coverage:** election (primary/secondary + re-elect) → Task 1 tests 1-2; presence + stale drop → test 3; role-change emitter → test 4; no-op path → test 5 + Task 2 test 1; opt-in enable + disposer + getters → Task 2; type export → Task 3; existing-suite safety (opt-in, unref timer) → Task 3 note.
- **Circular-dep avoidance:** hub defines its own `TabLockManager`/`TabChannel` (structural) + inline `defaultChannel` (BroadcastChannel wrapper) + `defaultLockManager` (navigator.locks) — **no import of `@noy-db/by-peer`/`by-tabs`** (they depend on hub). An app may still pass `tabsChannel()` (structurally compatible).
- **Type consistency:** `TabRole`/`TabPresence`/`TabLockManager`/`TabChannel`/`TabCoordinationOptions`, `TabCoordinator.{start,dispose,activeTabs,onTabRoleChange,onActiveTabsChange,_beat,role,tabId}`, `enableTabCoordination`/`tabRole`/`activeTabs` consistent across tasks.
- **Determinism:** injected `now` + explicit `_beat()` + stub lock manager + in-memory bus; no reliance on real timers/`navigator`. The one production timer is `unref()`'d and gated on a channel.
- **Verify-before-trust:** Task 2 confirms the `close()` teardown site in noydb.ts. Real lookup.
- **No placeholders:** every code step has complete code; every run step states command + expected result.
