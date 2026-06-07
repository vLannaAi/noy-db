# Snapshots Auto-Cadence + S3 Bundle Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in automatic snapshot cadence (`snapshotPolicy`) writing a single rolling key, plus an S3 bundle-mode adapter (`s3Bundle()`), closing the two unbuilt open questions of RFC #272.

**Architecture:** Auto-cadence lives in hub-core behind the existing `withSnapshots()` strategy: a new engine `autoSnapshot()` overwrites a fixed `<vault>__auto` key (separate from the immutable on-demand pool, exempt from retention), driven by a small dedicated `SnapshotScheduler` that subscribes to the db's `onAfterWrite` hook. The S3 adapter is an independent `s3Bundle()` export in `@noy-db/to-aws-s3` implementing `NoydbBundleStore` with OCC via S3 conditional writes (`IfMatch`/ETag).

**Tech Stack:** TypeScript (ES2022), Vitest (happy-dom), `@aws-sdk/client-s3`, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-06-07-snapshots-auto-cadence-and-s3-bundle-design.md`

---

## File Structure

**Piece A — auto-cadence (hub-core):**
- Create: `packages/hub/src/snapshots/policy.ts` — `SnapshotMode`, `SnapshotPolicy`.
- Create: `packages/hub/src/snapshots/scheduler.ts` — `SnapshotScheduler` + `SnapshotSchedulerCallbacks`.
- Modify: `packages/hub/src/snapshots/strategy.ts` — `SnapshotMeta.auto`, `SnapshotIndex.auto`, `SnapshotStrategy.autoSnapshot`/`.policy`, `NO_SNAPSHOTS.autoSnapshot`.
- Modify: `packages/hub/src/snapshots/engine.ts` — `autoKey`, `autoSnapshot`, `listSnapshots`.
- Modify: `packages/hub/src/snapshots/active.ts` — `WithSnapshotsOptions.snapshotPolicy`, wire `autoSnapshot` + `policy`.
- Modify: `packages/hub/src/snapshots/index.ts` — export `SnapshotPolicy`, `SnapshotMode`.
- Modify: `packages/hub/src/noydb.ts` — scheduler lifecycle (`initSnapshotCadence`, `onAfterWrite` trigger, `close()` stop).
- Modify: `packages/hub/src/index.ts` — re-export `SnapshotPolicy`, `SnapshotMode` from the snapshots subpath surface (if hub re-exports snapshot types).
- Test: `packages/hub/__tests__/snapshots.test.ts` (extend), `packages/hub/__tests__/snapshot-scheduler.test.ts` (new).

**Piece B — S3 bundle adapter:**
- Create: `packages/to-aws-s3/src/bundle.ts` — `s3Bundle()`, `S3BundleOptions`.
- Modify: `packages/to-aws-s3/src/index.ts` — re-export `s3Bundle`, `S3BundleOptions`.
- Test: `packages/to-aws-s3/__tests__/bundle.test.ts` (new).

**Cross-cutting:**
- Create: `showcases/src/96-snapshots-auto-cadence.showcase.test.ts`.
- Modify: `features.yaml`, `docs/subsystems/snapshots.md`, `packages/hub/CHANGELOG.md`, `packages/to-aws-s3/CHANGELOG.md`.

**Test command convention:** single file → `pnpm --filter <pkg> exec vitest run <relative-path>`; full package → `pnpm --filter <pkg> test`.

---

## Task 1: `SnapshotPolicy` type

**Files:**
- Create: `packages/hub/src/snapshots/policy.ts`

- [ ] **Step 1: Write the file**

```ts
/**
 * Cadence policy for automatic snapshots. Borrows the vocabulary of the sync
 * `SyncPolicy` (debounce / interval / minInterval / onUnload) but is a separate,
 * snapshot-specific shape — automatic snapshots write the single rolling
 * `<vault>__auto` key, never the immutable on-demand pool.
 *
 * Default mode is `'manual'`: no timers, snapshots stay on-demand.
 */
export type SnapshotMode = 'manual' | 'debounce' | 'interval'

export interface SnapshotPolicy {
  /** Trigger mode. Default `'manual'` — no automatic snapshots. */
  readonly mode?: SnapshotMode
  /** Idle delay (ms) after a write before an auto-snapshot fires. `mode:'debounce'`. Default 30_000. */
  readonly debounceMs?: number
  /** Fixed interval (ms). `mode:'interval'`. Default 300_000. */
  readonly intervalMs?: number
  /** Hard floor (ms) between auto-snapshots regardless of mode. Default 0. */
  readonly minIntervalMs?: number
  /** Flush a pending auto-snapshot on tab-hide / process exit. Default true for non-manual modes. */
  readonly onUnload?: boolean
  /** Label applied to each auto-snapshot. Default `'auto'`. */
  readonly label?: string
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @noy-db/hub exec tsc --noEmit`
Expected: PASS (no references yet — file is standalone).

- [ ] **Step 3: Commit**

```bash
git add packages/hub/src/snapshots/policy.ts
git commit -m "feat(hub/snapshots): SnapshotPolicy cadence type"
```

---

## Task 2: Strategy type additions (`auto` fields, `autoSnapshot`, `policy`, stub)

**Files:**
- Modify: `packages/hub/src/snapshots/strategy.ts`
- Test: `packages/hub/__tests__/snapshots.test.ts`

- [ ] **Step 1: Write the failing test** — append to `snapshots.test.ts` inside the existing `describe('NO_SNAPSHOTS stub', ...)` block:

```ts
  it('autoSnapshot() throws NOT_ENABLED', async () => {
    await expect(NO_SNAPSHOTS.autoSnapshot({}, 'user', {})).rejects.toThrow('withSnapshots')
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/snapshots.test.ts -t "autoSnapshot"`
Expected: FAIL — `NO_SNAPSHOTS.autoSnapshot is not a function`.

- [ ] **Step 3: Implement the type changes** in `strategy.ts`.

Add `auto` to `SnapshotMeta` (after the `integrity` field):

```ts
  readonly integrity: 'verified' | 'legacy-unverifiable'
  /** `true` for the rolling auto-snapshot; absent on on-demand checkpoints. */
  readonly auto?: true
}
```

Add `auto` to `SnapshotIndex`:

```ts
/** @internal */
export interface SnapshotIndex {
  snapshots: SnapshotMeta[]
  nextCounter: number
  /** Single rolling auto-snapshot slot, separate from the immutable `snapshots` pool. */
  auto?: SnapshotMeta
}
```

Add the import at the top of `strategy.ts`:

```ts
import type { SnapshotPolicy } from './policy.js'
```

Extend `SnapshotStrategy`:

```ts
/** @internal */
export interface SnapshotStrategy {
  snapshot(vault: unknown, by: string, opts?: { label?: string; note?: string }): Promise<SnapshotMeta>
  listSnapshots(vaultId: string): Promise<SnapshotMeta[]>
  restoreSnapshot(vault: unknown, version: string): Promise<void>
  /** Rolling auto-snapshot to the fixed `<vault>__auto` key. */
  autoSnapshot(vault: unknown, by: string, opts?: { label?: string; note?: string }): Promise<SnapshotMeta>
  /** Configured cadence policy. Undefined or `mode:'manual'` ⇒ no scheduler is wired. */
  readonly policy?: SnapshotPolicy
}
```

Add `autoSnapshot` to the `NO_SNAPSHOTS` stub:

```ts
export const NO_SNAPSHOTS: SnapshotStrategy = {
  async snapshot() { throw NOT_ENABLED },
  async listSnapshots() { throw NOT_ENABLED },
  async restoreSnapshot() { throw NOT_ENABLED },
  async autoSnapshot() { throw NOT_ENABLED },
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/snapshots.test.ts -t "autoSnapshot"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/snapshots/strategy.ts packages/hub/__tests__/snapshots.test.ts
git commit -m "feat(hub/snapshots): strategy auto-snapshot surface + index auto slot"
```

---

## Task 3: Engine `autoSnapshot` + rolling key + listSnapshots

**Files:**
- Modify: `packages/hub/src/snapshots/engine.ts`
- Test: `packages/hub/__tests__/snapshots.test.ts`

- [ ] **Step 1: Write the failing tests** — append a new `describe` block to `snapshots.test.ts`. (The file already has `makeMockStore()` and `makeMockVault()` helpers.)

```ts
describe('SnapshotEngine.autoSnapshot — rolling key', () => {
  it('writes a single fixed key and overwrites it on repeat', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    const vault = makeMockVault('v1') as Parameters<typeof engine.autoSnapshot>[0]

    const m1 = await engine.autoSnapshot(vault, 'user')
    const m2 = await engine.autoSnapshot(vault, 'user')

    expect(m1.version).toBe('v1__auto')
    expect(m2.version).toBe('v1__auto')
    expect(m1.auto).toBe(true)
    expect(m1.label).toBe('auto')
    // Only the auto blob + the index blob exist — no accumulation.
    expect([...store.blobs.keys()].sort()).toEqual(['v1__auto', 'v1__index'])
  })

  it('lists the auto snapshot first, ahead of the immutable pool', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    const vault = makeMockVault('v1') as Parameters<typeof engine.snapshot>[0]

    await engine.snapshot(vault, 'user', { label: 'manual-1' })
    await engine.autoSnapshot(vault, 'user')

    const list = await engine.listSnapshots('v1')
    expect(list[0]!.version).toBe('v1__auto')
    expect(list[1]!.label).toBe('manual-1')
  })

  it('is exempt from retention — auto survives keepLast:1 churn', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, { keepLast: 1 })
    const vault = makeMockVault('v1') as Parameters<typeof engine.snapshot>[0]

    await engine.autoSnapshot(vault, 'user')
    await engine.snapshot(vault, 'user', { label: 'm1' })
    await engine.snapshot(vault, 'user', { label: 'm2' }) // prunes m1 from the pool

    const list = await engine.listSnapshots('v1')
    // auto + the single retained manual snapshot
    expect(list.some(s => s.version === 'v1__auto')).toBe(true)
    expect(list.filter(s => !s.auto).length).toBe(1)
    expect(list.find(s => !s.auto)!.label).toBe('m2')
  })

  it('restores the auto snapshot by its key', async () => {
    const store = makeMockStore()
    const engine = new SnapshotEngine(store, {})
    const vault = makeMockVault('v1') as Parameters<typeof engine.autoSnapshot>[0]
    await engine.autoSnapshot(vault, 'user')
    await expect(engine.restoreSnapshot(vault, 'v1__auto')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/snapshots.test.ts -t "rolling key"`
Expected: FAIL — `engine.autoSnapshot is not a function`.

- [ ] **Step 3: Implement** in `engine.ts`.

Add `autoKey` next to the existing `snapKey`:

```ts
  private autoKey(vaultName: string): string {
    return `${vaultName}__auto`
  }
```

Add the `autoSnapshot` method (after `snapshot`):

```ts
  /**
   * Rolling auto-snapshot. Overwrites the single fixed `<vault>__auto` key and
   * stores its meta in `index.auto`, separate from the immutable `snapshots`
   * pool — retention never prunes it. Used by the cadence scheduler.
   */
  async autoSnapshot(
    vault: Vault,
    by: string,
    opts?: { label?: string; note?: string },
  ): Promise<SnapshotMeta> {
    const bytes = await writeNoydbBundle(vault, {})
    const { index, indexVersion } = await this.readIndex(vault.name)
    const key = this.autoKey(vault.name)

    // Unconditional overwrite of the rolling slot.
    await this.store.writeBundle(key, bytes, null)

    const meta: SnapshotMeta = {
      version: key,
      label: opts?.label ?? 'auto',
      ...(opts?.note !== undefined ? { note: opts.note } : {}),
      exportedAt: new Date().toISOString(),
      exportedBy: by,
      size: bytes.length,
      integrity: 'verified',
      auto: true,
    }

    index.auto = meta
    await this.writeIndex(vault.name, index, indexVersion)
    return meta
  }
```

Replace `listSnapshots` with:

```ts
  async listSnapshots(vaultId: string): Promise<SnapshotMeta[]> {
    const { index } = await this.readIndex(vaultId)
    const immutable = [...index.snapshots].reverse()
    return index.auto ? [index.auto, ...immutable] : immutable
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/snapshots.test.ts`
Expected: PASS (all snapshot tests, old + new).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/snapshots/engine.ts packages/hub/__tests__/snapshots.test.ts
git commit -m "feat(hub/snapshots): engine autoSnapshot rolling key + retention exemption"
```

---

## Task 4: `SnapshotScheduler`

**Files:**
- Create: `packages/hub/src/snapshots/scheduler.ts`
- Test: `packages/hub/__tests__/snapshot-scheduler.test.ts`

- [ ] **Step 1: Write the failing test** (new file):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SnapshotScheduler } from '../src/snapshots/scheduler.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function makeCallbacks(pending = 1) {
  let count = pending
  const fire = vi.fn(async () => { count = 0 })
  return { fire, pendingCount: () => count, setPending: (n: number) => { count = n } }
}

describe('SnapshotScheduler', () => {
  it('debounce coalesces a burst of writes into one fire', async () => {
    const cb = makeCallbacks(1)
    const s = new SnapshotScheduler({ mode: 'debounce', debounceMs: 1000 }, cb)
    s.start()
    s.notifyChange(); s.notifyChange(); s.notifyChange()
    expect(cb.fire).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(cb.fire).toHaveBeenCalledTimes(1)
    s.stop()
  })

  it('interval mode fires on each tick regardless of notifyChange', async () => {
    const cb = makeCallbacks(1)
    const s = new SnapshotScheduler({ mode: 'interval', intervalMs: 500 }, cb)
    s.start()
    await vi.advanceTimersByTimeAsync(500)
    cb.setPending(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(cb.fire).toHaveBeenCalledTimes(2)
    s.stop()
  })

  it('does not fire when nothing is pending', async () => {
    const cb = makeCallbacks(0)
    const s = new SnapshotScheduler({ mode: 'debounce', debounceMs: 100 }, cb)
    s.start()
    s.notifyChange()
    await vi.advanceTimersByTimeAsync(100)
    expect(cb.fire).not.toHaveBeenCalled()
    s.stop()
  })

  it('minIntervalMs floor reschedules instead of firing too soon', async () => {
    const cb = makeCallbacks(1)
    const s = new SnapshotScheduler({ mode: 'debounce', debounceMs: 100, minIntervalMs: 1000 }, cb)
    s.start()
    s.notifyChange()
    await vi.advanceTimersByTimeAsync(100)
    expect(cb.fire).toHaveBeenCalledTimes(1) // first fire (lastFireTime was 0)
    cb.setPending(1)
    s.notifyChange()
    await vi.advanceTimersByTimeAsync(100) // 200ms elapsed < 1000ms floor
    expect(cb.fire).toHaveBeenCalledTimes(1) // suppressed, rescheduled
    await vi.advanceTimersByTimeAsync(1000)
    expect(cb.fire).toHaveBeenCalledTimes(2)
    s.stop()
  })

  it('stop() clears timers — no fire after stop', async () => {
    const cb = makeCallbacks(1)
    const s = new SnapshotScheduler({ mode: 'debounce', debounceMs: 100 }, cb)
    s.start()
    s.notifyChange()
    s.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(cb.fire).not.toHaveBeenCalled()
  })

  it('notifyChange is a no-op under manual/interval modes', async () => {
    const cb = makeCallbacks(1)
    const s = new SnapshotScheduler({ mode: 'interval', intervalMs: 1000 }, cb)
    s.start()
    s.notifyChange()
    await vi.advanceTimersByTimeAsync(999)
    expect(cb.fire).not.toHaveBeenCalled()
    s.stop()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/snapshot-scheduler.test.ts`
Expected: FAIL — cannot find module `scheduler.js`.

- [ ] **Step 3: Implement** `packages/hub/src/snapshots/scheduler.ts`:

```ts
/**
 * Owns timers + unload hooks for the automatic snapshot cadence. Distinct from
 * the sync `SyncScheduler` (whose push/pull/dirty-count shape doesn't map to
 * snapshots) — it borrows only the policy vocabulary. Delegates the actual
 * snapshot work to `callbacks.fire()`.
 */
import type { SnapshotPolicy } from './policy.js'

export interface SnapshotSchedulerCallbacks {
  /** Fire one auto-snapshot cycle (per dirty vault). Swallows its own per-vault errors. */
  fire(): Promise<void>
  /** Number of vaults with pending writes since the last fire. */
  pendingCount(): number
}

export class SnapshotScheduler {
  private readonly policy: SnapshotPolicy
  private readonly callbacks: SnapshotSchedulerCallbacks

  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private lastFireTime = 0
  private firing = false
  private started = false

  private readonly boundVisibility: (() => void) | null = null
  private readonly boundUnload: (() => void) | null = null

  constructor(policy: SnapshotPolicy, callbacks: SnapshotSchedulerCallbacks) {
    this.policy = policy
    this.callbacks = callbacks
    if (this.shouldRegisterUnload()) {
      this.boundVisibility = this.handleVisibility.bind(this)
      this.boundUnload = this.handleUnload.bind(this)
    }
  }

  start(): void {
    if (this.started) return
    this.started = true

    if (this.policy.mode === 'interval') {
      const ms = this.policy.intervalMs ?? 300_000
      this.intervalTimer = setInterval(() => { void this.execFire() }, ms)
    }

    if (this.boundVisibility && this.boundUnload) {
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this.boundVisibility)
      }
      if (typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('pagehide', this.boundUnload)
      }
      if (typeof process !== 'undefined' && typeof process.on === 'function') {
        process.on('beforeExit', this.boundUnload)
      }
    }
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null }
    if (this.intervalTimer) { clearInterval(this.intervalTimer); this.intervalTimer = null }

    if (this.boundVisibility && this.boundUnload) {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.boundVisibility)
      }
      if (typeof globalThis.removeEventListener === 'function') {
        globalThis.removeEventListener('pagehide', this.boundUnload)
      }
      if (typeof process !== 'undefined' && typeof process.removeListener === 'function') {
        process.removeListener('beforeExit', this.boundUnload)
      }
    }
  }

  notifyChange(): void {
    if (!this.started) return
    if (this.policy.mode === 'debounce') this.resetDebounce()
  }

  private resetDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    const ms = this.policy.debounceMs ?? 30_000
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.execFire()
    }, ms)
  }

  private async execFire(): Promise<void> {
    if (this.firing) return

    const minInterval = this.policy.minIntervalMs ?? 0
    if (minInterval > 0 && Date.now() - this.lastFireTime < minInterval) {
      if (this.policy.mode === 'debounce') this.resetDebounce()
      return
    }
    if (this.callbacks.pendingCount() === 0) return

    this.firing = true
    try {
      await this.callbacks.fire()
      this.lastFireTime = Date.now()
    } catch {
      // fire() swallows per-vault errors; this guards the contract regardless.
    } finally {
      this.firing = false
    }
  }

  private handleVisibility(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.flush()
    }
  }

  private handleUnload(): void {
    this.flush()
  }

  private flush(): void {
    if (this.callbacks.pendingCount() === 0) return
    void this.callbacks.fire().catch(() => {})
  }

  private shouldRegisterUnload(): boolean {
    return this.policy.onUnload ?? (this.policy.mode !== 'manual')
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/snapshot-scheduler.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/snapshots/scheduler.ts packages/hub/__tests__/snapshot-scheduler.test.ts
git commit -m "feat(hub/snapshots): SnapshotScheduler (debounce/interval/minInterval/onUnload)"
```

---

## Task 5: Wire `snapshotPolicy` through `withSnapshots` + exports

**Files:**
- Modify: `packages/hub/src/snapshots/active.ts`
- Modify: `packages/hub/src/snapshots/index.ts`

- [ ] **Step 1: Write the failing test** — append to `snapshots.test.ts`:

```ts
describe('withSnapshots — policy passthrough', () => {
  it('exposes the configured snapshotPolicy on the strategy', () => {
    const store = makeMockStore()
    const strat = withSnapshots({ store, snapshotPolicy: { mode: 'debounce', debounceMs: 5000 } })
    expect(strat.policy?.mode).toBe('debounce')
    expect(strat.policy?.debounceMs).toBe(5000)
  })

  it('omits policy when none is configured (manual default)', () => {
    const store = makeMockStore()
    const strat = withSnapshots({ store })
    expect(strat.policy).toBeUndefined()
  })

  it('delegates autoSnapshot to the engine', async () => {
    const store = makeMockStore()
    const strat = withSnapshots({ store })
    const vault = makeMockVault('vp') as unknown
    const meta = await strat.autoSnapshot(vault, 'user')
    expect(meta.version).toBe('vp__auto')
    expect(meta.auto).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/snapshots.test.ts -t "policy passthrough"`
Expected: FAIL — `strat.autoSnapshot is not a function` / `policy` undefined where expected.

- [ ] **Step 3: Implement** `active.ts`:

```ts
import { SnapshotEngine } from './engine.js'
import type { SnapshotStrategy, RetentionPolicy } from './strategy.js'
import type { SnapshotPolicy } from './policy.js'
import type { NoydbBundleStore } from '../types.js'
import type { Vault } from '../vault.js'

export interface WithSnapshotsOptions {
  /** Bundle store where snapshot blobs and the sidecar index are written. */
  store: NoydbBundleStore
  /**
   * Declarative retention policy. Enforced eagerly after each on-demand `snapshot()`.
   * Defaults to no retention (all on-demand snapshots kept forever). Never affects
   * the rolling auto-snapshot.
   */
  retention?: RetentionPolicy
  /**
   * Automatic-snapshot cadence. Default `mode:'manual'` ⇒ no timers; snapshots
   * stay on-demand. Set `mode:'debounce'`/`'interval'` to enable auto-snapshots
   * to the rolling `<vault>__auto` key.
   */
  snapshotPolicy?: SnapshotPolicy
}

export function withSnapshots(opts: WithSnapshotsOptions): SnapshotStrategy {
  const engine = new SnapshotEngine(opts.store, opts.retention ?? {})
  return {
    snapshot(vault, by, snapOpts) {
      return engine.snapshot(vault as Vault, by, snapOpts)
    },
    listSnapshots(vaultId) {
      return engine.listSnapshots(vaultId)
    },
    restoreSnapshot(vault, version) {
      return engine.restoreSnapshot(vault as Vault, version)
    },
    autoSnapshot(vault, by, snapOpts) {
      return engine.autoSnapshot(vault as Vault, by, snapOpts)
    },
    ...(opts.snapshotPolicy ? { policy: opts.snapshotPolicy } : {}),
  }
}
```

Update `index.ts`:

```ts
export { withSnapshots } from './active.js'
export type { WithSnapshotsOptions } from './active.js'
export type { SnapshotStrategy, SnapshotMeta, RetentionPolicy } from './strategy.js'
export type { SnapshotPolicy, SnapshotMode } from './policy.js'
export { SnapshotNotFoundError } from '../errors.js'
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/snapshots.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/snapshots/active.ts packages/hub/src/snapshots/index.ts packages/hub/__tests__/snapshots.test.ts
git commit -m "feat(hub/snapshots): snapshotPolicy option + autoSnapshot delegation + exports"
```

---

## Task 6: Wire the cadence scheduler into `Noydb`

**Files:**
- Modify: `packages/hub/src/noydb.ts`
- Test: `packages/hub/__tests__/snapshots.test.ts`

Context (already present in `noydb.ts`):
- `this.snapshotStrategy` assigned at line ~235 in the constructor.
- `this.vaultCache: Map<string, Vault>` (line 167) — resolves an open vault by name.
- `this.options.user` — the writer identity (used by `db.snapshot`).
- `onAfterWrite(handler)` (line ~1288) — fires `WriteEvent` (`event.vault` is the vault name) after each committed write; handler errors are warned, never thrown.
- `close()` (line ~1418) — synchronous teardown.
- `this.closed` flag.

- [ ] **Step 1: Write the failing test** — append to `snapshots.test.ts`:

```ts
describe('Noydb auto-cadence wiring', () => {
  it('manual default wires no auto-snapshot on writes', async () => {
    const store = makeMockStore()
    const db = await createNoydb({ store: memory(), user: 'u', secret: 'pw', snapshotStrategy: withSnapshots({ store }) })
    const v = await db.openVault('cad1')
    const c = v.collection<{ id: string; n: number }>('items')
    await c.put('a', { id: 'a', n: 1 })
    await new Promise(r => setTimeout(r, 20))
    const list = await db.listSnapshots('cad1')
    expect(list.find(s => s.auto)).toBeUndefined()
    db.close()
  })

  it('debounce policy auto-snapshots after a write and is restorable', async () => {
    const store = makeMockStore()
    const db = await createNoydb({
      store: memory(), user: 'u', secret: 'pw',
      snapshotStrategy: withSnapshots({ store, snapshotPolicy: { mode: 'debounce', debounceMs: 10, onUnload: false } }),
    })
    const v = await db.openVault('cad2')
    const c = v.collection<{ id: string; n: number }>('items')
    await c.put('a', { id: 'a', n: 1 })
    // wait past the debounce window for the auto-snapshot to land
    await new Promise(r => setTimeout(r, 60))
    const list = await db.listSnapshots('cad2')
    const auto = list.find(s => s.auto)
    expect(auto).toBeDefined()
    expect(auto!.version).toBe('cad2__auto')
    db.close()
  })

  it('close() stops the scheduler (no auto-snapshot after close)', async () => {
    const store = makeMockStore()
    const db = await createNoydb({
      store: memory(), user: 'u', secret: 'pw',
      snapshotStrategy: withSnapshots({ store, snapshotPolicy: { mode: 'debounce', debounceMs: 50, onUnload: false } }),
    })
    const v = await db.openVault('cad3')
    const c = v.collection<{ id: string; n: number }>('items')
    await c.put('a', { id: 'a', n: 1 })
    db.close()
    await new Promise(r => setTimeout(r, 80))
    // index never written because the debounce timer was cleared on close
    expect(store.blobs.has('cad3__auto')).toBe(false)
  })
})
```

> Note: these use real timers (small ms) because `createNoydb`'s write path is async; fake timers complicate the await chain. Keep the windows tiny.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/snapshots.test.ts -t "auto-cadence wiring"`
Expected: FAIL — the debounce test finds no auto snapshot (no wiring yet).

- [ ] **Step 3: Implement** in `noydb.ts`.

Add the import (near the other snapshot import at line ~109):

```ts
import { SnapshotScheduler } from './snapshots/scheduler.js'
```

Add fields (near `private readonly snapshotStrategy: SnapshotStrategy` at line ~208):

```ts
  private snapshotScheduler: SnapshotScheduler | null = null
  private readonly dirtySnapshotVaults = new Set<string>()
```

In the constructor, immediately after `this.snapshotStrategy = options.snapshotStrategy ?? NO_SNAPSHOTS` (line ~235), add:

```ts
    this.initSnapshotCadence()
```

Add the method (place it near the `snapshot`/`listSnapshots` methods, ~line 2790):

```ts
  /**
   * Wire the automatic-snapshot cadence when a non-manual `snapshotPolicy` is
   * configured. Subscribes to `onAfterWrite` to mark the written vault dirty and
   * nudge the scheduler; the scheduler fires `autoSnapshot()` per dirty vault.
   * No-op for `mode:'manual'` or no policy.
   */
  private initSnapshotCadence(): void {
    const policy = this.snapshotStrategy.policy
    if (!policy || !policy.mode || policy.mode === 'manual') return

    const scheduler = new SnapshotScheduler(policy, {
      fire: async () => {
        const names = [...this.dirtySnapshotVaults]
        this.dirtySnapshotVaults.clear()
        for (const name of names) {
          const v = this.vaultCache.get(name)
          if (!v) continue
          try {
            await this.snapshotStrategy.autoSnapshot(v, this.options.user)
          } catch (err) {
            console.warn(
              `[noy-db] auto-snapshot failed for vault "${name}": ` +
              (err instanceof Error ? err.message : String(err)),
            )
          }
        }
      },
      pendingCount: () => this.dirtySnapshotVaults.size,
    })

    this.onAfterWrite((event) => {
      this.dirtySnapshotVaults.add(event.vault)
      scheduler.notifyChange()
    })
    scheduler.start()
    this.snapshotScheduler = scheduler
  }
```

In `close()` (line ~1418), add near the top of the method body:

```ts
    this.snapshotScheduler?.stop()
    this.snapshotScheduler = null
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/snapshots.test.ts`
Expected: PASS (all snapshot tests).

- [ ] **Step 5: Full hub typecheck + test**

Run: `pnpm --filter @noy-db/hub exec tsc --noEmit && pnpm --filter @noy-db/hub test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/noydb.ts packages/hub/__tests__/snapshots.test.ts
git commit -m "feat(hub/snapshots): wire auto-cadence scheduler via onAfterWrite + close() teardown"
```

---

## Task 7: `s3Bundle()` adapter

**Files:**
- Create: `packages/to-aws-s3/src/bundle.ts`
- Modify: `packages/to-aws-s3/src/index.ts`
- Test: `packages/to-aws-s3/__tests__/bundle.test.ts`

- [ ] **Step 1: Write the failing test** (new file). The existing `listPage.test.ts` shows the inject-a-mock-`S3Client` pattern; the bundle adapter needs `transformToByteArray()` on the GetObject Body.

```ts
import { describe, it, expect } from 'vitest'
import type { S3Client } from '@aws-sdk/client-s3'
import { BundleVersionConflictError } from '@noy-db/hub'
import { s3Bundle } from '../src/bundle.js'

/** In-memory fake S3 with ETag + IfMatch semantics. */
function fakeS3(): { client: S3Client; objects: Map<string, { body: Uint8Array; etag: string }> } {
  const objects = new Map<string, { body: Uint8Array; etag: string }>()
  let etagSeq = 0
  const client = {
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name
      const input = (command as { input: Record<string, unknown> }).input
      const key = input.Key as string
      if (name === 'GetObjectCommand') {
        const obj = objects.get(key)
        if (!obj) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e }
        return { ETag: `"${obj.etag}"`, Body: { async transformToByteArray() { return obj.body } } }
      }
      if (name === 'PutObjectCommand') {
        const current = objects.get(key)
        const ifMatch = input.IfMatch as string | undefined
        if (ifMatch !== undefined && (!current || current.etag !== ifMatch)) {
          const e = new Error('PreconditionFailed'); e.name = 'PreconditionFailed'
          ;(e as { $metadata?: unknown }).$metadata = { httpStatusCode: 412 }
          throw e
        }
        const etag = `etag-${++etagSeq}`
        objects.set(key, { body: input.Body as Uint8Array, etag })
        return { ETag: `"${etag}"` }
      }
      if (name === 'DeleteObjectCommand') { objects.delete(key); return {} }
      if (name === 'ListObjectsV2Command') {
        const pfx = (input.Prefix as string) ?? ''
        const contents = [...objects.entries()]
          .filter(([k]) => k.startsWith(pfx))
          .map(([k, v]) => ({ Key: k, ETag: `"${v.etag}"`, Size: v.body.length }))
        return { Contents: contents, IsTruncated: false }
      }
      throw new Error(`unexpected command ${name}`)
    },
  } as unknown as S3Client
  return { client, objects }
}

const bytes = (s: string) => new TextEncoder().encode(s)

describe('s3Bundle', () => {
  it('has kind "bundle" and name "s3"', () => {
    const { client } = fakeS3()
    const store = s3Bundle({ bucket: 'b', client })
    expect(store.kind).toBe('bundle')
    expect(store.name).toBe('s3')
  })

  it('round-trips write then read with the .noydb key scheme', async () => {
    const { client, objects } = fakeS3()
    const store = s3Bundle({ bucket: 'b', prefix: 'snaps', client })
    const w = await store.writeBundle('v1__snap_000001', bytes('hello'), null)
    expect(w.version).toBeTruthy()
    expect([...objects.keys()]).toEqual(['snaps/v1__snap_000001.noydb'])
    const r = await store.readBundle('v1__snap_000001')
    expect(new TextDecoder().decode(r!.bytes)).toBe('hello')
    expect(r!.version).toBe(w.version)
  })

  it('readBundle returns null for a missing key', async () => {
    const { client } = fakeS3()
    const store = s3Bundle({ bucket: 'b', client })
    expect(await store.readBundle('nope')).toBeNull()
  })

  it('null expectedVersion overwrites unconditionally (rolling auto key)', async () => {
    const { client } = fakeS3()
    const store = s3Bundle({ bucket: 'b', client })
    await store.writeBundle('v__auto', bytes('one'), null)
    await store.writeBundle('v__auto', bytes('two'), null)
    const r = await store.readBundle('v__auto')
    expect(new TextDecoder().decode(r!.bytes)).toBe('two')
  })

  it('IfMatch on a stale version throws BundleVersionConflictError', async () => {
    const { client } = fakeS3()
    const store = s3Bundle({ bucket: 'b', client })
    const w1 = await store.writeBundle('k', bytes('a'), null)
    await store.writeBundle('k', bytes('b'), null) // advances the ETag
    await expect(store.writeBundle('k', bytes('c'), w1.version)).rejects.toThrow(BundleVersionConflictError)
  })

  it('IfMatch on the current version succeeds', async () => {
    const { client } = fakeS3()
    const store = s3Bundle({ bucket: 'b', client })
    const w1 = await store.writeBundle('k', bytes('a'), null)
    const w2 = await store.writeBundle('k', bytes('b'), w1.version)
    expect(w2.version).not.toBe(w1.version)
  })

  it('listBundles derives vaultId/version/size with no GetObject', async () => {
    const { client } = fakeS3()
    const store = s3Bundle({ bucket: 'b', prefix: 'p', client })
    await store.writeBundle('v1__index', bytes('idx'), null)
    await store.writeBundle('v1__snap_000001', bytes('snapshot-bytes'), null)
    const list = await store.listBundles()
    const ids = list.map(x => x.vaultId).sort()
    expect(ids).toEqual(['v1__index', 'v1__snap_000001'])
    const snap = list.find(x => x.vaultId === 'v1__snap_000001')!
    expect(snap.size).toBe(bytes('snapshot-bytes').length)
    expect(snap.version).toBeTruthy()
  })

  it('deleteBundle removes the object', async () => {
    const { client, objects } = fakeS3()
    const store = s3Bundle({ bucket: 'b', client })
    await store.writeBundle('k', bytes('a'), null)
    await store.deleteBundle('k')
    expect(objects.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/to-aws-s3 exec vitest run __tests__/bundle.test.ts`
Expected: FAIL — cannot find `../src/bundle.js`.

- [ ] **Step 3: Implement** `packages/to-aws-s3/src/bundle.ts`:

```ts
/**
 * **s3Bundle** — whole-vault bundle store for noy-db over Amazon S3.
 *
 * Implements the `NoydbBundleStore` contract (read/write/delete/list of whole
 * `.noydb` blobs) with optimistic concurrency via S3 conditional writes. Pairs
 * with `@noy-db/hub` snapshots (`withSnapshots({ store: s3Bundle(...) })`) and
 * with bundle-mode sync.
 *
 * Key scheme: `{prefix}/{vaultId}.noydb`. The version token is the object ETag.
 *
 * **OCC:** `writeBundle(id, bytes, expectedVersion)` —
 *   - `expectedVersion === null` → unconditional `PutObject` (first write / rolling overwrite).
 *   - `expectedVersion = <etag>` → `PutObject` with `IfMatch`; a 412 becomes `BundleVersionConflictError`.
 *
 * Requires `@aws-sdk/client-s3` ≥ 3.696 (conditional-write `IfMatch` on PutObject, GA Nov 2024).
 *
 * @packageDocumentation
 */
import type { NoydbBundleStore } from '@noy-db/hub'
import { BundleVersionConflictError } from '@noy-db/hub'
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'

export interface S3BundleOptions {
  /** S3 bucket name. */
  bucket: string
  /** Key prefix within the bucket. Default ''. Keys are `{prefix}/{vaultId}.noydb`. */
  prefix?: string
  /** AWS region. Used only when `client` is not provided. Default 'us-east-1'. */
  region?: string
  /** Pre-built S3Client. If provided, `region` is ignored. */
  client?: S3Client
}

const SUFFIX = '.noydb'

function stripQuotes(etag: string | undefined): string {
  return (etag ?? '').replace(/^"|"$/g, '')
}

export function s3Bundle(options: S3BundleOptions): NoydbBundleStore {
  const { bucket, prefix = '' } = options
  const client = options.client ?? new S3Client({
    ...(options.region ? { region: options.region } : {}),
  })

  const listPrefix = prefix ? `${prefix}/` : ''
  function objectKey(vaultId: string): string {
    return `${listPrefix}${vaultId}${SUFFIX}`
  }

  return {
    kind: 'bundle',
    name: 's3',

    async readBundle(vaultId) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey(vaultId) }))
        if (!res.Body) return null
        const bytes = await (res.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
        return { bytes, version: stripQuotes(res.ETag) }
      } catch (err: unknown) {
        if (err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound')) return null
        throw err
      }
    },

    async writeBundle(vaultId, bytes, expectedVersion) {
      try {
        const res = await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey(vaultId),
          Body: bytes,
          ContentType: 'application/octet-stream',
          ...(expectedVersion !== null ? { IfMatch: expectedVersion } : {}),
        }))
        let version = stripQuotes(res.ETag)
        if (!version) {
          const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey(vaultId) }))
          version = stripQuotes(head.ETag)
        }
        return { version }
      } catch (err: unknown) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        if (err instanceof Error && (err.name === 'PreconditionFailed' || status === 412)) {
          throw new BundleVersionConflictError(
            `S3 bundle "${vaultId}" changed since expectedVersion="${expectedVersion}".`,
          )
        }
        throw err
      }
    },

    async deleteBundle(vaultId) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(vaultId) }))
    },

    async listBundles() {
      const out: Array<{ vaultId: string; version: string; size: number }> = []
      let token: string | undefined
      do {
        const res = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: listPrefix,
          ...(token ? { ContinuationToken: token } : {}),
        }))
        for (const obj of res.Contents ?? []) {
          const key = obj.Key ?? ''
          if (!key.endsWith(SUFFIX)) continue
          out.push({
            vaultId: key.slice(listPrefix.length, -SUFFIX.length),
            version: stripQuotes(obj.ETag),
            size: obj.Size ?? 0,
          })
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (token)
      return out
    },
  }
}
```

Update `packages/to-aws-s3/src/index.ts` — add at the end (keep the existing `s3` export untouched):

```ts
export { s3Bundle } from './bundle.js'
export type { S3BundleOptions } from './bundle.js'
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @noy-db/to-aws-s3 exec vitest run __tests__/bundle.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full package typecheck + test**

Run: `pnpm --filter @noy-db/to-aws-s3 exec tsc --noEmit && pnpm --filter @noy-db/to-aws-s3 test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/to-aws-s3/src/bundle.ts packages/to-aws-s3/src/index.ts packages/to-aws-s3/__tests__/bundle.test.ts
git commit -m "feat(to-aws-s3): s3Bundle NoydbBundleStore adapter (OCC via IfMatch/ETag)"
```

---

## Task 8: Showcase 96 — auto-cadence + restore

**Files:**
- Create: `showcases/src/96-snapshots-auto-cadence.showcase.test.ts`

- [ ] **Step 1: Write the showcase test** (it must pass on first run — showcases are executable docs). Model the header on showcase 93.

```ts
/**
 * Showcase 96 — automatic snapshot cadence (rolling auto key) + S3 bundle store
 *
 * What you'll learn
 * ─────────────────
 *   1. `withSnapshots({ snapshotPolicy })` fires automatic whole-vault
 *      snapshots on a debounce cadence after writes.
 *   2. Auto-snapshots write a single rolling `<vault>__auto` key — they never
 *      accumulate and never evict labeled on-demand checkpoints.
 *   3. Both the rolling auto snapshot and labeled checkpoints are restorable.
 *
 * Why it matters
 * ──────────────
 * Local-first apps want periodic durable backups without hand-rolling a timer,
 * dirty-tracking, and flush-on-unload — while preserving the integrity-verified
 * on-demand checkpoints that mark "a version worth keeping".
 *
 * Prerequisites
 * ─────────────
 * - Showcase 93 (withSnapshots checkpoint/restore).
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → snapshots
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withSnapshots } from '@noy-db/hub/snapshots'
import { memory } from '@noy-db/to-memory'

// A reusable in-memory bundle store for the snapshot destination.
function memoryBundleStore() {
  const blobs = new Map<string, Uint8Array>()
  const versions = new Map<string, string>()
  let seq = 0
  return {
    kind: 'bundle' as const,
    name: 'mem-bundle',
    async readBundle(id: string) {
      const bytes = blobs.get(id)
      return bytes ? { bytes, version: versions.get(id)! } : null
    },
    async writeBundle(id: string, bytes: Uint8Array, _expected: string | null) {
      const version = `v${++seq}`
      blobs.set(id, bytes); versions.set(id, version)
      return { version }
    },
    async deleteBundle(id: string) { blobs.delete(id); versions.delete(id) },
    async listBundles() {
      return [...blobs.keys()].map(k => ({ vaultId: k, version: versions.get(k)!, size: blobs.get(k)!.length }))
    },
  }
}

describe('Showcase 96 — automatic snapshot cadence', () => {
  it('auto-snapshots on a debounce cadence, leaving labeled checkpoints intact', async () => {
    const store = memoryBundleStore()
    const db = await createNoydb({
      store: memory(), user: 'acct', secret: 'pw-96',
      snapshotStrategy: withSnapshots({
        store,
        snapshotPolicy: { mode: 'debounce', debounceMs: 10, onUnload: false },
      }),
    })
    const vault = await db.openVault('ledger')
    const entries = vault.collection<{ id: string; amount: number }>('entries')

    // A deliberate, labeled checkpoint — the "version worth keeping".
    await entries.put('e1', { id: 'e1', amount: 100 })
    await db.snapshot('ledger', { label: 'before-May-close' })

    // Ongoing edits drive the automatic cadence.
    await entries.put('e2', { id: 'e2', amount: 250 })
    await new Promise(r => setTimeout(r, 50)) // let the debounce fire

    const list = await db.listSnapshots('ledger')
    const auto = list.find(s => s.auto)
    const labeled = list.find(s => s.label === 'before-May-close')

    expect(auto?.version).toBe('ledger__auto')   // rolling auto snapshot exists
    expect(labeled).toBeDefined()                // labeled checkpoint untouched by cadence

    // The rolling auto snapshot restores like any other.
    await expect(db.restoreSnapshot('ledger', 'ledger__auto')).resolves.toBeUndefined()
    db.close()
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @noy-db/showcases exec vitest run src/96-snapshots-auto-cadence.showcase.test.ts`
Expected: PASS.

> If the showcases package filter name differs, discover it with `node -e "console.log(require('./showcases/package.json').name)"` and substitute.

- [ ] **Step 3: Commit**

```bash
git add showcases/src/96-snapshots-auto-cadence.showcase.test.ts
git commit -m "test(showcases): showcase 96 — snapshot auto-cadence + restore"
```

---

## Task 9: Registry + docs + CHANGELOGs

**Files:**
- Modify: `features.yaml`
- Modify: `docs/subsystems/snapshots.md`
- Modify: `packages/hub/CHANGELOG.md`
- Modify: `packages/to-aws-s3/CHANGELOG.md`

- [ ] **Step 1: Update `features.yaml`** — locate the `snapshots` feature entry. Add invariants for auto-cadence and reference showcase 96. Add a note for the `s3Bundle` adapter under the storage/snapshots surface. (Read the existing `snapshots` block first to match the exact YAML shape — invariants list + showcases list. Append, do not restructure.)

Example shape to append to the snapshots feature's `invariants:` and `showcases:`:

```yaml
    invariants:
      # ...existing...
      - "Automatic snapshots (snapshotPolicy mode debounce/interval) write a single rolling <vault>__auto key, separate from the immutable on-demand pool"
      - "The rolling auto-snapshot is exempt from retention (keepLast/maxAgeDays never prune it)"
      - "snapshotPolicy defaults to manual — no timers unless explicitly enabled"
    showcases:
      # ...existing...
      - 96
```

- [ ] **Step 2: Verify the registry** — run the spec-coverage check the repo uses.

Run: `pnpm --filter @noy-db/showcases test 2>/dev/null; node scripts/check-features.* 2>/dev/null || true`
Then confirm the canonical check: search for the CI "Spec coverage" job command.

Run: `grep -rn "features.yaml\|Spec coverage\|check-features" .github/workflows package.json scripts 2>/dev/null | head`
Run the discovered command (e.g. `pnpm features:check` or `node scripts/<file>`).
Expected: PASS (no dangling refs).

- [ ] **Step 3: Update `docs/subsystems/snapshots.md`** — add two sections:

````markdown
## Automatic cadence

`withSnapshots({ snapshotPolicy })` enables automatic whole-vault snapshots driven
by vault writes. Automatic snapshots overwrite a single rolling key
(`<vault>__auto`) and are **exempt from retention** — the timer can never evict
your labeled on-demand checkpoints.

```ts
const db = await createNoydb({
  store,
  snapshotStrategy: withSnapshots({
    store: snapshotStore,
    snapshotPolicy: { mode: 'debounce', debounceMs: 60_000, minIntervalMs: 300_000 },
    retention: { keepLast: 10 }, // applies to on-demand checkpoints only
  }),
})
```

| `mode` | Trigger |
|---|---|
| `'manual'` (default) | No timers — `db.snapshot()` only. |
| `'debounce'` | `debounceMs` of write-idle, with a `minIntervalMs` floor. |
| `'interval'` | Fixed `intervalMs` timer. |

`onUnload` (default true for non-manual) flushes a pending auto-snapshot on
tab-hide / process exit. The auto snapshot appears first in `listSnapshots()` and
restores like any other (`db.restoreSnapshot(vault, '<vault>__auto')`). The
scheduler is torn down by `db.close()`.

## S3 bundle store

`@noy-db/to-aws-s3` ships `s3Bundle()` — a `NoydbBundleStore` for whole-vault
`.noydb` blobs (distinct from the per-record `s3()` adapter), suitable as a
snapshot destination.

```ts
import { s3Bundle } from '@noy-db/to-aws-s3'

const snapshotStore = s3Bundle({ bucket: 'my-backups', prefix: 'noydb', region: 'us-east-1' })
const db = await createNoydb({ store, snapshotStrategy: withSnapshots({ store: snapshotStore }) })
```

OCC uses S3 conditional writes (`IfMatch` on the object ETag); a lost race throws
`BundleVersionConflictError`. Requires `@aws-sdk/client-s3` ≥ 3.696.
````

- [ ] **Step 4: Update CHANGELOGs** — add an entry at the top of each (under a new next-pre-release heading; the exact version is set during the release cycle, use `## Unreleased` if unsure).

`packages/hub/CHANGELOG.md`:

```markdown
## Unreleased

### Feature: automatic snapshot cadence ([#272](https://github.com/vLannaAi/noy-db/issues/272))

- `withSnapshots({ snapshotPolicy })` — opt-in automatic whole-vault snapshots on a `debounce`/`interval` cadence (default `manual`). Auto-snapshots write a single rolling `<vault>__auto` key, decoupled from the immutable on-demand pool and **exempt from retention** so the timer never evicts labeled checkpoints. Flushes on tab-hide/exit; torn down by `db.close()`.
- `SnapshotMeta.auto` flags the rolling snapshot; it lists first and restores like any checkpoint.
```

`packages/to-aws-s3/CHANGELOG.md`:

```markdown
## Unreleased

### Feature: s3Bundle bundle-mode adapter ([#272](https://github.com/vLannaAi/noy-db/issues/272))

- `s3Bundle()` implements the `NoydbBundleStore` contract (whole-vault `.noydb` blobs) — a snapshot/bundle destination distinct from the per-record `s3()` adapter. OCC via S3 conditional writes (`IfMatch`/ETag) → `BundleVersionConflictError`; `listBundles()` derives metadata from one `ListObjectsV2` (no per-object GET). Requires `@aws-sdk/client-s3` ≥ 3.696.
```

- [ ] **Step 5: Commit**

```bash
git add features.yaml docs/subsystems/snapshots.md packages/hub/CHANGELOG.md packages/to-aws-s3/CHANGELOG.md
git commit -m "docs(snapshots): auto-cadence + s3Bundle docs, features.yaml, CHANGELOGs (#272)"
```

---

## Task 10: Full verification sweep

- [ ] **Step 1: Repo-wide typecheck**

Run: `pnpm -r typecheck`
Expected: PASS (every package).

- [ ] **Step 2: Repo-wide lint**

Run: `pnpm -r lint`
Expected: PASS (exit 0).

- [ ] **Step 3: Targeted tests**

Run: `pnpm --filter @noy-db/hub test && pnpm --filter @noy-db/to-aws-s3 test && pnpm --filter @noy-db/showcases exec vitest run src/96-snapshots-auto-cadence.showcase.test.ts`
Expected: PASS.

- [ ] **Step 4: Build the two changed packages** (catches dist/export drift)

Run: `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/to-aws-s3 build`
Expected: PASS.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "chore(snapshots): verification fixes"  # only if the sweep required changes
```

---

## Self-Review (completed during planning)

**1. Spec coverage:**
- Auto-cadence policy type → Task 1. ✅
- `SnapshotMeta.auto` / `SnapshotIndex.auto` / strategy surface / stub → Task 2. ✅
- Engine rolling key + retention exemption + listSnapshots → Task 3. ✅
- `SnapshotScheduler` (debounce/interval/minInterval/onUnload/stop) → Task 4. ✅
- `withSnapshots({ snapshotPolicy })` passthrough + exports → Task 5. ✅
- noydb wiring (onAfterWrite trigger, fire-per-dirty-vault, conflict swallow, close teardown, manual default) → Task 6. ✅
- `s3Bundle()` (read/write/delete/list, OCC IfMatch/null-unconditional/412, no-GET list) → Task 7. ✅
- Showcase 96 → Task 8. ✅
- features.yaml + docs + CHANGELOGs → Task 9. ✅
- Verification sweep → Task 10. ✅

**2. Placeholder scan:** No TBD/TODO; every code step has complete code. The one discovery step (Task 9 Step 2) gives an exact command to find the canonical features-check rather than guessing the script name. ✅

**3. Type consistency:** `autoSnapshot(vault, by, opts?)`, `SnapshotMeta.auto?: true`, `SnapshotIndex.auto?`, `SnapshotPolicy.mode`, `s3Bundle`/`S3BundleOptions`, `version` token = stripped ETag — names consistent across Tasks 1–9. The mock S3 `transformToByteArray` matches the adapter's read path. ✅
