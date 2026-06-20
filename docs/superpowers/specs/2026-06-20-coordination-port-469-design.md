# Kernel coordination/quorum port (drain-barrier) — design (#469)

**Status:** design (approved 2026-06-20) — ready for implementation plan
**Issue:** noy-db #469. Builds on #232 (`coordinatedCutover` drain-barrier) and #228 (multi-client coordination).
**Scope:** the **kernel + transport side** — Slice 1 (port + default impl + refactor), Slice 2 (`@noy-db/by-tabs` impl), Slice 3 (`@noy-db/by-peer` impl). **Out of scope:** Slice 4 — the klum-side cross-vault session-consolidation orchestrator (lives in `@klum-db/lobby`).

## Goal

Make the drain-barrier a **kernel-injected `CoordinationProvider` port** that an external orchestrator (klum) drives through the `Noydb` handle **without depending on `by-*`**, and that `by-tabs`/`by-peer` implement for real-time (sub-ms) quorum. Default behavior is unchanged: with nothing injected, today's store-polling barrier runs verbatim.

## The dependency-inversion principle (third instance of the seam)

noy-db already inverts two dependencies through injected ports: `NoydbStore` (← `to-*`, app injects) and `SealingKeyProvider` (← `seal-*`/`at-*`, app injects). **Coordination is the third:** the kernel defines the port, `by-tabs`/`by-peer` implement it, the app wires the concrete impl into `Noydb`, and an orchestrator reaches it polymorphically through the handle — never naming a `by-*` package. The dependency arrow is `by-* → kernel ← klum`, app at the apex.

## Current state (verified 2026-06-20)

- **The barrier (#232) is hardcoded store-polling.** `SchemaFenceController` (migrator) and `FenceWatcher` (writer) read/write plaintext docs (`_meta/schema-fence`, `_meta/schema-fence:client:<id>`) and poll. Quorum is `activeQuiesced(store, vault, {generation, staleMs, excludeClientId})` — true when every active (non-stale) client has `quiescedAtVersion === generation`. The local drain primitive is `WriteQueueTracker.onFlush()`. `assertWritable` gates writes while fenced. Neither class takes an injected transport — both take only `store` + `onFlush`.
- **Injection pattern:** `NoydbOptions` carries ~15 optional `*Strategy` ports, each defaulted to a NO-OP and threaded `Noydb → Vault` as a field — tree-shakeable. Adding `coordinationStrategy?` is the 16th instance.
- **`by-tabs`/`by-peer` are transport plugins** exposing a common `PeerChannel` duplex (`send`/`on('message'|'close')`/`close`/`isOpen`). `by-tabs` = `tabsChannel({name}): PeerChannel` (BroadcastChannel). `by-peer` = `peerStore`/`servePeerStore`/`createOffer`/`acceptOffer` + `pairInMemory()` test harness + `fromDataChannel(dc)`. Neither has any fence/quiesce/cutover code today. `CrossTabWriteRelay` (hub) already broadcasts write signals over a BroadcastChannel — the relay pattern to copy.

## Design

### The port (`@noy-db/hub/kernel`)

```ts
/** Vault fence state (the existing FenceDoc). */
interface FenceState {
  readonly currentSchemaVersion: number
  readonly fenceState: 'normal' | 'draining' | 'migrating' | 'complete'
}

/** A writer's presence + ack, tagged with the session that owns it. */
interface WriterPresence {
  readonly writerId: string             // = today's clientId (per tab/peer)
  readonly sessionId: string            // groups one user's writers across vaults
  readonly lastSeen: number
  readonly quiescedAtVersion: number | null
}

/** Session-addressable drain-barrier coordination transport. Per-vault ops. */
interface CoordinationProvider {
  // orchestrator → all writers
  setFence(vault: string, fence: FenceState): Promise<void>
  // writer observes fence changes (default: poll-emit; by-*: push)
  observeFence(vault: string, onChange: (f: FenceState) => void): Unsubscribe
  // writer → orchestrator: presence + ack (heartbeat + quiescedAtVersion)
  reportPresence(vault: string, p: WriterPresence): Promise<void>
  // orchestrator observes presence changes (default: poll-emit; by-*: push) — for event-driven quorum
  observePresence(vault: string, onChange: (writers: readonly WriterPresence[]) => void): Unsubscribe
  // orchestrator one-shot snapshot of reachable writers (quorum input)
  reachableWriters(vault: string, o: { staleMs: number; now: number }): Promise<readonly WriterPresence[]>
}
```

**Quorum is a pure function** (extracted from `activeQuiesced`):
```ts
function isQuorum(writers: readonly WriterPresence[], generation: number, excludeWriterId?: string): boolean {
  return writers.filter(w => w.writerId !== excludeWriterId).every(w => w.quiescedAtVersion === generation)
}
```

**A reusable barrier protocol** in hub (so klum and the migration cutover share one implementation):
```ts
// drain self → setFence(draining) → await quorum (observePresence + isQuorum, or timeout) → run() → release
async function runDrainBarrier(
  provider: CoordinationProvider,
  o: { vault: string; generation: number; onFlush: () => Promise<void>; writerId: string;
       staleMs: number; quiesceTimeoutMs: number; now: () => number },
  run: () => Promise<void>,
): Promise<void>
```
`SchemaFenceController.runCutover` becomes a thin caller of `runDrainBarrier` with `run` = the per-collection transform loop.

### Slice 1 — port + default impl + refactor (pure hub, behavior-preserving)

- Define the port + `WriterPresence` + `FenceState` + `isQuorum` + `runDrainBarrier`, exported from `@noy-db/hub/kernel` (the contract klum binds to).
- **`StoreCoordinationProvider`** (hub default, e.g. `packages/hub/src/coordination/store-provider.ts`): maps the five methods to today's ops — `setFence`→`saveFence`, `observeFence`→poll `loadFence` at `pollIntervalMs` + emit-on-change, `reportPresence`→`writeClientDoc`, `observePresence`→poll `listClientDocs` + emit, `reachableWriters`→`listClientDocs` filtered by `staleMs`. Byte-identical store I/O.
- **Refactor** `SchemaFenceController` + `FenceWatcher` to take a `CoordinationProvider` instead of the raw `store`, and dispatch through it. `activeQuiesced` → `isQuorum` over `reachableWriters()`. The migrator uses `runDrainBarrier`; the watcher uses `observeFence` + `reportPresence`.
- **Inject:** `coordinationStrategy?: CoordinationProvider` on `NoydbOptions`. When omitted, `Noydb` constructs `new StoreCoordinationProvider(this.store, { pollIntervalMs })`. Surface as `noydb.coordination` (readonly) so an orchestrator reaches it through the handle.
- **Session id:** the `Vault`/`Noydb` already has `_clientId` (the `writerId`). Add a `sessionId` (instance-level, default = a generated id, overridable via options) carried on every `reportPresence`. Hub only *carries* it; consolidation is Slice 4.

**Result:** with no `coordinationStrategy`, all existing fence tests pass unchanged (same store ops, same poll cadence). The port + `noydb.coordination` are new, additive surface.

### Slice 2 — `by-tabs` real-time impl

`tabsCoordination(channel: PeerChannel): CoordinationProvider` in `packages/by-tabs`. Protocol over the channel (a dedicated message envelope, distinct from `CrossTabWriteRelay`'s):
- `setFence` → broadcast `{ k: 'fence', vault, fence }`.
- `observeFence` → `channel.on('message')`, filter `k==='fence' && msg.vault===vault`.
- `reportPresence` → broadcast `{ k: 'presence', vault, presence }`; also update a local presence map keyed by `writerId`.
- `observePresence` → on presence messages, update the local map (prune by `staleMs`) and emit the map.
- `reachableWriters` → snapshot of the local map filtered by `staleMs`.
No store round-trip; BroadcastChannel is origin-scoped + sub-ms. Self-messages are not echoed (BroadcastChannel semantics) — the provider records its own presence locally.

### Slice 3 — `by-peer` real-time impl

`peerCoordination(channel: PeerChannel): CoordinationProvider` in `packages/by-peer`. Identical message protocol over the `PeerChannel` (WebRTC DataChannel or `pairInMemory`). Same local-presence-map approach. Multi-peer fan-out uses the same broadcast-on-channel; a mesh of `PeerChannel`s (or the existing server-mux) carries it. Verified headlessly with `pairInMemory()`.

### How klum reaches it (no `by-*` dependency)

klum imports the `CoordinationProvider` type from `@noy-db/hub/kernel` and reaches `db.coordination` on the injected `Noydb`. To drive a fleet barrier it calls `runDrainBarrier`/the port per vault, grouping by `WriterPresence.sessionId` for the consolidated experience (Slice 4, klum repo). klum never imports `by-tabs`/`by-peer` — the app wired the concrete provider in.

## Files

**Slice 1 (hub):**
- Create `packages/hub/src/coordination/types.ts` — `CoordinationProvider`, `WriterPresence`, `FenceState`, `isQuorum`, `runDrainBarrier`.
- Create `packages/hub/src/coordination/store-provider.ts` — `StoreCoordinationProvider`.
- Modify `packages/hub/src/schema-update/fence-controller.ts` + `fence-watcher.ts` — dispatch through the provider; reuse `runDrainBarrier`.
- Modify `packages/hub/src/schema-update/client-registry.ts` — keep the doc shape; `activeQuiesced` → re-expressed via `isQuorum` (or kept as the store-provider's internal).
- Modify `packages/hub/src/kernel/index.ts` — export the port + helpers.
- Modify `packages/hub/src/types.ts` (`NoydbOptions`) + `noydb.ts` + `vault.ts` — `coordinationStrategy?`, default construction, `noydb.coordination`, `sessionId`.

**Slice 2:** `packages/by-tabs/src/coordination.ts` (`tabsCoordination`) + barrel export + tests.
**Slice 3:** `packages/by-peer/src/coordination.ts` (`peerCoordination`) + barrel export + tests.

## Testing & verification

- **Slice 1:** all existing `schema-update`/fence/cutover tests pass UNCHANGED (proves behavior-preservation). New unit tests: `isQuorum` (pure), `StoreCoordinationProvider` round-trips against an in-memory store, `runDrainBarrier` (drain → quorum → run → release; offline writer surfaced, timeout). Type test: a `Noydb` surfaces `coordination`; a hand-rolled `CoordinationProvider` is injectable.
- **Slice 2:** `tabsCoordination` over a mocked/`jsdom` BroadcastChannel: two providers reach quorum in real time; a non-acking member blocks; stale member pruned. A full multi-"tab" cutover via the injected provider.
- **Slice 3:** `peerCoordination` over `pairInMemory()`: same matrix headlessly.
- All slices: `pnpm check:architecture` (no outbound `@klum-db`), build/typecheck/lint.

## Out of scope
- **Slice 4 (klum):** the cross-vault **session-consolidation** orchestrator ("one pause per user across their vaults"), the fleet rollout state machine, vault-split. Drives this port; lives in `@klum-db/lobby`.
- The per-vault **transform** (`additiveOnly`/`schemaUpdate`/`carrySchemas`) — unchanged, stays hub (#245). The barrier *drives* it; doesn't own it.

## Risks / edge cases
- **Offline writers:** `reachableWriters` prunes by `staleMs` (a stale writer is excluded from quorum, surfaced as pending, never blocks forever) — identical to today's `activeQuiesced`. Real-time impls must expire presence on `staleMs` too (no liveness message → drop).
- **Migrator self-exclusion:** the migrator drains synchronously via `onFlush`; `isQuorum` excludes its own `writerId` (as `activeQuiesced` does today via `excludeClientId`).
- **`observeFence` for the store default = a poll loop** — the poll interval moves from `FenceWatcher` into `StoreCoordinationProvider`; cadence preserved so timing-sensitive tests don't shift.
- **Real-time vs store consistency:** when a `by-*` provider is injected, fence/presence travel the channel, NOT the store — so the `_meta/schema-fence*` docs are no longer the source of truth in that topology. Acceptable (the provider IS the truth); but a mixed fleet (some store-only, some channel) would partition. v1 assumes one provider per instance (the app's choice); document that mixing transports for one vault's coordination is unsupported.
- **Message-protocol collision:** the by-* coordination envelope must be distinct from `CrossTabWriteRelay`'s; use a separate channel name or a `k` discriminator namespace.

## Decisions recorded
1. Inject at `Noydb` level, ops per-vault (session-addressability is cross-vault). 2. Default impl ships in hub core (zero-config unchanged); `by-*` opt-in. 3. `sessionId` in the interface from day one (hub carries; klum consolidates). 4. One reusable `runDrainBarrier` in hub (migration cutover + klum share it). 5. Event-driven quorum via `observePresence` (store impl poll-emits; `by-*` push) — uniform interface, latency differs by impl.
