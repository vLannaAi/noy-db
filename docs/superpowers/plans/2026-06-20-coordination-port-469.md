# Kernel Coordination Port (#469) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extract the drain-barrier into an injected `CoordinationProvider` kernel port (default = today's store-polling, behavior-preserving), then add real-time `by-tabs` and `by-peer` implementations.

**Architecture:** Dependency-inversion port (3rd instance after `NoydbStore`/`SealingKeyProvider`). The fence subsystem dispatches through the port; the default `StoreCoordinationProvider` reproduces current store I/O; `by-*` provide channel-based real-time impls. Session-addressable (`sessionId` carried).

**Tech Stack:** TypeScript, pnpm workspaces, vitest. **Spec:** `docs/superpowers/specs/2026-06-20-coordination-port-469-design.md` (read it).

**Publish discipline:** the release step MUST NOT run without explicit user confirmation.

---

## File Structure

**Slice 1 (hub):**
- Create `packages/hub/src/coordination/types.ts` — port + `WriterPresence` + `FenceState` + `isQuorum` + `runDrainBarrier`.
- Create `packages/hub/src/coordination/store-provider.ts` — `StoreCoordinationProvider`.
- Create `packages/hub/src/coordination/index.ts` — subsystem barrel.
- Modify `packages/hub/src/schema-update/fence-controller.ts`, `fence-watcher.ts`, `client-registry.ts`.
- Modify `packages/hub/src/kernel/index.ts`, `types.ts` (`NoydbOptions`), `noydb.ts`, `vault.ts`.
- Tests: `packages/hub/__tests__/coordination-*.test.ts`.

**Slice 2:** `packages/by-tabs/src/coordination.ts`, barrel, `packages/by-tabs/__tests__/coordination.test.ts`.
**Slice 3:** `packages/by-peer/src/coordination.ts`, barrel, `packages/by-peer/__tests__/coordination.test.ts`.

---

## PHASE 1 — Slice 1: port + default + refactor (hub)

Branch: `feat/coordination-port-469`.

### Task 1.1 — The port, `isQuorum`, `runDrainBarrier`

**Files:** Create `packages/hub/src/coordination/types.ts`; Test `packages/hub/__tests__/coordination-port.test.ts`.

- [ ] **Step 1 — failing test** for `isQuorum` (pure) + `runDrainBarrier` (against a hand-rolled in-memory mock provider):
  - `isQuorum`: all-acked → true; one writer `quiescedAtVersion !== generation` → false; excluded writerId ignored; empty → true.
  - `runDrainBarrier`: drives a mock provider — `setFence(draining)` called, `onFlush` awaited, resolves when the mock reports all-acked via `observePresence`, calls `run()`, then `setFence`/release; throws on quiesce timeout with a non-acking writer.
- [ ] **Step 2** run → fail (module missing).
- [ ] **Step 3 — implement** `packages/hub/src/coordination/types.ts`:

```ts
import type { Unsubscribe } from '../write-hooks.js'

export interface FenceState {
  readonly currentSchemaVersion: number
  readonly fenceState: 'normal' | 'draining' | 'migrating' | 'complete'
}

export interface WriterPresence {
  readonly writerId: string
  readonly sessionId: string
  readonly lastSeen: number
  readonly quiescedAtVersion: number | null
}

export interface CoordinationProvider {
  setFence(vault: string, fence: FenceState): Promise<void>
  observeFence(vault: string, onChange: (f: FenceState) => void): Unsubscribe
  reportPresence(vault: string, p: WriterPresence): Promise<void>
  observePresence(vault: string, onChange: (writers: readonly WriterPresence[]) => void): Unsubscribe
  reachableWriters(vault: string, o: { staleMs: number; now: number }): Promise<readonly WriterPresence[]>
}

/** Pure quorum: every reachable writer (excluding self) acked `generation`. */
export function isQuorum(
  writers: readonly WriterPresence[],
  generation: number,
  excludeWriterId?: string,
): boolean {
  return writers
    .filter((w) => w.writerId !== excludeWriterId)
    .every((w) => w.quiescedAtVersion === generation)
}

export interface DrainBarrierOptions {
  readonly vault: string
  readonly generation: number
  readonly writerId: string
  readonly onFlush: () => Promise<void>
  readonly staleMs: number
  readonly quiesceTimeoutMs: number
  readonly now: () => number
  /** Test seam: advance other clients between quorum checks. */
  readonly onPoll?: () => Promise<void>
}

/**
 * Generalized drain-barrier: drain self → wait for quorum (event-driven via
 * observePresence, with a one-shot reachableWriters seed) → run() → done.
 * Reusable by the migration cutover AND a klum orchestrator. Does NOT mutate
 * fence state itself beyond the caller's responsibility — the caller wraps
 * run() with the migrate/complete transitions.
 */
export async function runDrainBarrier(
  provider: CoordinationProvider,
  o: DrainBarrierOptions,
  run: () => Promise<void>,
): Promise<void> {
  await provider.setFence(o.vault, { currentSchemaVersion: o.generation, fenceState: 'draining' })
  await o.onFlush()

  const deadline = o.now() + o.quiesceTimeoutMs
  const seeded = await provider.reachableWriters(o.vault, { staleMs: o.staleMs, now: o.now() })
  if (!isQuorum(seeded, o.generation, o.writerId)) {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => { if (!settled) { settled = true; unsub(); fn() } }
      const unsub = provider.observePresence(o.vault, (writers) => {
        if (isQuorum(writers, o.generation, o.writerId)) finish(resolve)
      })
      const tick = async () => {
        if (settled) return
        if (o.now() >= deadline) {
          finish(() => reject(new Error(`Quorum timeout on "${o.vault}" at generation ${o.generation}`)))
          return
        }
        if (o.onPoll) await o.onPoll()
        const w = await provider.reachableWriters(o.vault, { staleMs: o.staleMs, now: o.now() })
        if (isQuorum(w, o.generation, o.writerId)) finish(resolve)
        else setTimeout(() => void tick(), 25)
      }
      void tick()
    })
  }
  await run()
}
```

(Note: the existing `QuiesceTimeoutError`/`SchemaFenceError` in `../errors.js` should be reused instead of a bare `Error` — the implementer wires those; shown bare here for brevity.)

- [ ] **Step 4** run → pass. **Step 5** typecheck + lint. **Step 6** commit.

### Task 1.2 — `StoreCoordinationProvider` (default, behavior-preserving)

**Files:** Create `packages/hub/src/coordination/store-provider.ts`; Test `packages/hub/__tests__/coordination-store-provider.test.ts`.

The implementer reads the CURRENT store ops in `schema-update/fence.ts` (`loadFence`/`saveFence`, the `_meta/schema-fence` doc) and `client-registry.ts` (`writeClientDoc`/`listClientDocs`/`ClientDoc` shape) and maps:
- `setFence(vault, fence)` → `saveFence(store, vault, fence)`.
- `observeFence(vault, cb)` → start a `setInterval(pollIntervalMs)` that `loadFence`s and calls `cb` on change; return an unsubscribe that clears it.
- `reportPresence(vault, p)` → `writeClientDoc(store, vault, p.writerId, { lastSeen, quiescedAtVersion, sessionId })` (extend `ClientDoc` with `sessionId?` — additive).
- `observePresence(vault, cb)` → `setInterval` polling `listClientDocs` → emit the mapped `WriterPresence[]` on change.
- `reachableWriters(vault, {staleMs, now})` → `listClientDocs` mapped to `WriterPresence`, filtered `now - lastSeen <= staleMs`.

- [ ] TDD: round-trip against the existing in-memory store helper — set/observe fence, report/observe presence, reachableWriters prunes stale. Assert the doc shapes written match today's (so existing fence tests stay green). Commit.

### Task 1.3 — Refactor the fence to dispatch through the provider

**Files:** Modify `schema-update/fence-controller.ts`, `fence-watcher.ts`, `client-registry.ts`.

- `SchemaFenceController`: constructor takes `coordination: CoordinationProvider` (+ `writerId`, `sessionId`, `onFlush`, timeouts) instead of `store`. `runCutover` becomes: for the migrator role, call `runDrainBarrier(coordination, {...}, run)` where `run` does `setFence(migrating)` → transforms → `setFence(complete/normal)` + version bump. `assertWritable` reads fence via `coordination.observeFence`/a cached latest (or a `readFence` — if needed, add `readFence` to the provider; PREFER caching the last `observeFence` value to avoid a 6th method).
- `FenceWatcher`: subscribe `coordination.observeFence`; on `draining`, `onFlush` → `coordination.reportPresence(ack)`; heartbeat timer → `reportPresence(lastSeen)`.
- Keep `ClientDoc`/`FenceDoc` shapes; `activeQuiesced` re-expressed via `isQuorum` (or kept inside `StoreCoordinationProvider`).

- [ ] **Verification (the proof):** run the FULL existing `schema-update`/fence/cutover suite with NO provider injected (Noydb default = `StoreCoordinationProvider`). All pass unchanged. Adjust only timing seams (`onPoll`) if a test drove the old poll directly. Commit.

### Task 1.4 — Injection + Noydb surface + kernel export

**Files:** Modify `types.ts` (`NoydbOptions`), `noydb.ts`, `vault.ts`, `kernel/index.ts`, `coordination/index.ts`.

- Add `readonly coordinationStrategy?: CoordinationProvider` + `readonly sessionId?: string` to `NoydbOptions`.
- In `Noydb`: `this.coordination = options.coordinationStrategy ?? new StoreCoordinationProvider(this.store, { pollIntervalMs })`; `this.sessionId = options.sessionId ?? generateULID()`; expose `get coordination()`. Thread `coordination` + `sessionId` + the existing `_clientId` (writerId) into the `Vault`'s `SchemaFenceController`/`FenceWatcher` construction.
- `kernel/index.ts`: export `type CoordinationProvider`, `type WriterPresence`, `type FenceState`, `isQuorum`, `runDrainBarrier`, `type DrainBarrierOptions`.
- [ ] **TDD:** a hand-rolled `CoordinationProvider` injected via `createNoydb({ coordinationStrategy })` is used by a cutover (assert the custom provider's methods are called); `db.coordination` is the injected instance; default (omitted) is a `StoreCoordinationProvider`. typecheck + lint + `pnpm check:architecture`. Commit.

### Task 1.5 — Phase-1 release prep (GATED)
- [ ] Lockstep bump `pre.26 → pre.27`; PR; **publish only on explicit user confirmation**. (May batch with Phase 2/3 — see end.)

---

## PHASE 2 — Slice 2: `by-tabs` real-time impl

### Task 2.1 — `tabsCoordination(channel)`
**Files:** Create `packages/by-tabs/src/coordination.ts`; barrel export; Test `packages/by-tabs/__tests__/coordination.test.ts`.

Implement `CoordinationProvider` over a `PeerChannel` (from `tabsChannel({name})`). Message envelope `{ k: 'fence'|'presence', vault, ... }` (namespaced distinctly from `CrossTabWriteRelay`). Maintain a local `Map<writerId, WriterPresence>`; `observePresence` emits the pruned map; `reachableWriters` snapshots it; `setFence`/`reportPresence` broadcast; `observeFence` filters incoming fence messages. Record own presence locally (BroadcastChannel doesn't echo self).

- [ ] TDD with a mocked BroadcastChannel (or two `pairInMemory`-style channels): two `tabsCoordination` instances reach quorum in real time; a non-acking member blocks `runDrainBarrier` to timeout; a member that stops heartbeating is pruned by `staleMs`. An end-to-end cutover: two `Noydb`s sharing a mocked channel, `coordinationStrategy: tabsCoordination(ch)`, run a cutover, both quiesce. Commit.

---

## PHASE 3 — Slice 3: `by-peer` real-time impl

### Task 3.1 — `peerCoordination(channel)`
**Files:** Create `packages/by-peer/src/coordination.ts`; barrel; Test `packages/by-peer/__tests__/coordination.test.ts`.

Same protocol over `PeerChannel`, verified with `pairInMemory()`. Reuse the message envelope + local-presence-map approach (consider extracting a shared `channelCoordination(channel)` helper if by-tabs/by-peer bodies are identical — they likely are; the only difference is the channel source, so a shared core in one package re-exported, or duplicated ~40 lines, is acceptable; implementer decides, noting the no-cross-package-internal rule — duplicate if a shared home is awkward).

- [ ] TDD over `pairInMemory()`: two peers reach quorum; offline peer pruned; full cutover across two `Noydb`s wired to the paired channels. Commit.

---

## Release (GATED — batch Slices 1–3)
- [ ] One lockstep bump (`pre.26 → pre.27`) covering hub + by-tabs + by-peer; PR; on **explicit user confirmation** cut the release; verify on npm.

---

## Self-Review
**Spec coverage:** port+isQuorum+runDrainBarrier → T1.1; default impl → T1.2; refactor (behavior-preserving) → T1.3; injection+surface+kernel → T1.4; by-tabs → T2.1; by-peer → T3.1; klum Slice 4 + the transform → out of scope (spec). **Type consistency:** `CoordinationProvider`'s 5 methods are used identically by `StoreCoordinationProvider`, `tabsCoordination`, `peerCoordination`, `runDrainBarrier`, and the refactored fence. **Open micro-decision (flagged in T1.3):** `assertWritable` needs the latest fence — prefer caching the last `observeFence` value over adding a `readFence` 6th method; implementer confirms during T1.3.
