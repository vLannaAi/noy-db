# M12 — Schema migration & coordinated cutover (epic design)

**Status:** approved design · **Date:** 2026-05-31 · **Milestone:** [#12 Schema upgrade + coordinated cutover](https://github.com/vLannaAi/noy-db/milestone/12)

**Goal:** Ship safe **non-additive** schema migration (#232) for a known-client, local-first, ciphertext-blind vault. The drain-barrier protocol is the destination; the other M12 issues are supporting cast, sequenced or deferred around it.

This is an **epic decomposition** doc. Each slice below gets its own spec → plan → implementation cycle. The shared design decisions are recorded here so they survive across those cycles.

---

## 1. Why this epic exists

In a ciphertext-blind, multi-client vault there is no server-of-truth that can transform records in flight — each client carries its own schema and the server cannot validate or transform. The hub already handles **additive** schema change well (typed core + refs + guards + `_v` record stamps + persisted JSON-Schema introspection). The gap is **non-additive (breaking)** migrations: rename, restructure, required-field addition, type change.

Conventional online schema change is unavailable by design, so migration must be a **client-side coordinated protocol**. #232 closes this — the only structural gap in the local-first story for schema evolution.

Concrete driving scenario: rename `invoice.totalAmount → invoice.amount.gross` (with a new currency field) across 10–20 clients on a shared SPA, replacing today's manual maintenance window (ask everyone to close the app, run a script, reopen) with an admin-triggered `v3 → v4` cutover that takes a 30–60 s drain and records the transition in the audit ledger.

## 2. Grounding — what already exists (and what doesn't)

These corrections to the original issue assumptions shape the whole design (verified against the current hub):

| Capability | State | Anchor |
|---|---|---|
| Write path | Synchronous-to-adapter; **no write buffer/queue** | `packages/hub/src/collection.ts` (`put`/`delete`) |
| `transaction()` | Exists; 4-phase buffer + CAS preflight + rollback | `packages/hub/src/tx/transaction.ts` |
| `_v` version stamps | Exists on every envelope (`EncryptedEnvelope._v`) | `packages/hub/src/types.ts` |
| `_meta/policy` | **Encrypted** at rest (NOT plaintext-bypass), load/save + cache | `packages/hub/src/policy/`, `noydb.ts` |
| Lifecycle ledger | Exists; hash-chained append API with `op` types | `packages/hub/src/history/ledger/store.ts` |
| `at-*` sealing providers | 5 packages; `seal`/`unseal`; **no host/leader concept** | `packages/at-*`, `team/managed-passphrase.ts` |
| Multi-tab / presence | `by-tabs` (BroadcastChannel), `by-peer` (**Web Locks leader election**), `Collection.presence()` (encrypted heartbeat, `staleMs`) | `packages/by-tabs`, `packages/by-peer`, `collection.ts` |
| Guards & MVs | Exist; hook into write path before/after commit | `packages/hub/src/guards/`, `materialized-views/` |
| Reactive layer | `@noy-db/in-vue` delegates to Vue refs; hub emits `change` events | `packages/in-vue/src/` |
| `with*()` factories | `withGuard`, `withDerivation`, `withMaterializedView`, `withOverlayedView` | various |
| `withMigrations()` / `withBilingualFields()` | **Do not exist** — new in this epic | — |

**Two assumptions in the issues were wrong and are corrected here:**
- There is **no new presence/heartbeat layer to build** — `by-peer` Web Locks election + `Collection.presence()` cover liveness and leader election.
- There is **no plaintext-bypass subsystem to build** — migration is inherently post-unlock (you need the DEK to transform records), so fence state reuses the existing **encrypted** `_meta/policy` machinery. #232's stated "extends plaintext-bypass surface" con is void.

## 3. Locked design decisions (#232)

Resolved during brainstorming; do not revert without a new spec:

| Decision | Choice | Consequence |
|---|---|---|
| Dispatch model | **Eager-only** (coordinated bulk transform) | No read-time `transform()`; no per-read cost; no mixed-version reads |
| Lazy/eager (orig OQ#2) | Settled → eager-only | — |
| `SchemaVersionStaleError` on read (orig OQ#5) | **Eliminated** | After the window every record is the new version |
| Barrier enforcement | **Cooperative + documented hardening** | `hub.write()` throws `SchemaFenceError` by convention; sealing-host enforcement is a documented future option, not built |
| Election (orig OQ#1) | **Reuse `by-peer` Web Locks** | No new leader mechanism, no `at-*` host dependency |
| Fence-state storage (orig OQ#4) | **Reuse encrypted `_meta/policy` machinery** | No plaintext subsystem; fence doc holds no PII anyway |
| Quiesce timeout (orig OQ#3) | **Configurable per-migration, vault default 60 s** | Unquiesced-past-timeout clients drop from the active set (presence marks them stale); migration proceeds |

Trust model: all clients run our code (known-client deployment). A malicious/buggy client *could* bypass the cooperative fence; in this deployment that is a non-threat. The hardening path (an `at-*` sealing host refusing to unseal write credentials while the fence is up) is documented for untrusted-client scenarios but explicitly out of scope for this epic.

## 4. #232 architecture (the destination)

A cooperative, eager, 4-state drain barrier built entirely on existing machinery.

### Fence document (encrypted, post-unlock only)

```
_meta/schema-fence  (encrypted, reuses _meta/policy load/save/cache)
  {
    currentSchemaVersion: number,
    targetSchemaVersion:  number,
    fenceState: 'normal' | 'draining' | 'migrating' | 'complete'
  }
_meta/schema-fence/clients/<clientId>  (per-client quiesce acks + heartbeat)
```

### Protocol

```
admin triggers v → v+1            ──▶ fenceState: 'draining'
  each active client:
    await hub.writeQueue.onFlush()        ← Slice 1 primitive
    refuse new user writes (throw SchemaFenceError)
    ack quiesced into _meta/schema-fence/clients/<id>
all active clients quiesced (or timeout) ──▶ fenceState: 'migrating'
  by-peer Web Locks elects ONE client     ← existing election
  elected client runs withMigrations() transform() over all records, in bulk
  appends ledger op:'migration'           ← existing LedgerStore.append
complete                          ──▶ fenceState: 'complete', currentSchemaVersion bumps
  clients reload → resume on new schema
  late offline client → MigrationRequiredError on next write → must reload
```

### Registration API

```ts
withMigrations({
  collection: 'invoices',
  from: 3,
  to:   4,
  transform: (doc) => ({
    ...doc,
    amount: { gross: doc.totalAmount, currency: 'THB' },
    totalAmount: undefined,
  }),
})
```

Eager dispatch only: `transform` runs in bulk during the `migrating` phase. Passed to `createNoydb({ migrationStrategies: [...] })` following the existing `with*()` → strategy-handle → `_init*()` registry pattern.

### Error classes

A shared `SchemaMigrationError` base, with:

| Class | Thrown when |
|---|---|
| `SchemaFenceError` | Write attempted while `fenceState ∈ {draining, migrating}` |
| `MigrationRequiredError` | Write attempted by a client whose `schemaVersion < currentSchemaVersion` |

(`SchemaVersionStaleError` from the original issue is **not** needed — eager-only eliminates mixed-version reads.)

### Reused, not built

`Collection.presence()` (liveness/heartbeat, `staleMs`); `by-peer` Web Locks (election); `_meta/policy` load/save (fence doc); `LedgerStore.append` (audit entry); `_v` stamp (version gating); the `with*()` factory pattern.

## 5. Slice plan

### Slice 1 — #227 observable write-queue / flush  *(plan this first)*

The only true prerequisite on the critical path, with standalone value before #232 exists.

Because there is no write buffer today, "write-queue" means **tracking outstanding in-flight write promises**, not a buffer. A vault-level counter on the `Noydb` instance increments when a write chain starts and decrements when it settles (success *or* error), aggregating across all collections (drain is vault-wide).

The hub core stays framework-agnostic — it exposes a small signal/emitter (consistent with the existing `emit('change')` pattern), **not** a Vue `ref`. `@noy-db/in-vue` wraps it into a `ref` in Slice 3.

```ts
hub.writeQueue.pending: boolean        // depth > 0   (getter)
hub.writeQueue.depth:   number         // outstanding write count (getter)
hub.writeQueue.onChange(fn): Unsubscribe   // emitter for reactive wrappers
hub.writeQueue.onFlush(): Promise<void>    // resolves at depth 0; REJECTS if a write error halted the queue
```

- **Error semantics:** if a write rejects, `onFlush()` rejects (so a drain caller surfaces the error rather than hanging).
- **Adapter-agnostic:** reflects the in-flight chain regardless of adapter (memory/IDB/file/remote). If the adapter batches, `pending` reflects the batch.
- **Standalone value:** `beforeunload` guard, logout/lock guard, save-spinner.
- **Testing:** memory adapter with artificially delayed `put`; assert `depth` rises/falls, `pending` flips, `onFlush()` resolves at 0 and rejects on injected write error; concurrent multi-collection writes aggregate correctly.

### Slice 2 — #232 drain-barrier core

The headline. Implements Section 4 in full: `withMigrations()` factory + registry, the `_meta/schema-fence` doc (encrypted), the 4-state protocol driven by `by-peer` election + `Collection.presence()`, the `onFlush()`-based quiesce, eager bulk transform, ledger `op:'migration'`, and the two error classes. Admin trigger API to start a cutover. No UI in this slice (CLI/programmatic trigger is fine for tests).

### Slice 3 — #233 reactive fence-state + Vue UI

Surfaces #232 to the app via `@noy-db/in-vue` (note: package is `in-vue`, not `@noy-db/vue` as the issue draft says). `useMigrationState()` composable (`fenceState`, `schemaVersion`, `activePeers` as refs), lifecycle hooks (`onDrainStart`/`onQuiesceRequired`/`onMigrating`/`onComplete`/`onError`), `ackQuiesced()`, optional `onFence: 'queue' | 'throw'` (default `throw`) with a configurable queue depth (default 50), and error-boundary-friendly typed errors. Tree-shake-able.

### Independent follow-ups (after headline, not gating)

- **#230 write lifecycle hooks** (`beforeWrite`/`afterWrite`, `WriteEvent` with `txId`) — independently shippable; aids audit/versioning. The ledger #232 needs already exists internally, so #230 is **not** a #232 prerequisite.
- **#229 schema introspection** (`listCollections`/`guards`/`mvs`/`overlays`/`i18nFields`/`userGrants`) — independently shippable; aids migration audit and diagnostics dashboards.

### Deferred to a separate "hub coordination" epic

- **#228** full multi-client conflict detection (leader election, cross-tab write propagation, `WriteConflict` events). Its presence/election foundations are reused by #232, but its headline conflict-detection feature is not on this path.
- **#231** dry-run transaction mode. Builds on `transaction()`'s existing phase-2 preflight (a natural fit later) but is not needed for migration.

## 6. Cross-cutting requirements

- Every slice's implementation plan must add its `features.yaml` registry entries — CI's "Spec coverage" job fails on dangling spec↔artefact refs.
- Fence state and migration APIs are post-unlock only; calling them pre-unlock throws `VaultLockedError` (consistent with existing `_meta` access).
- New subsystems follow the lazy-dynamic-import convention so apps that never migrate pay zero bundle cost (as guards/MVs do today).
- Client-privacy: examples use generic `invoices`/`amount` shapes, never the real client domain.

## 7. Success criteria

1. An admin can trigger `v3 → v4` on a multi-client vault; clients drain (flush + quiesce) within the configured window; one elected client bulk-transforms all records; the ledger records `op:'migration'`; clients reload onto v4.
2. A write during `draining`/`migrating` throws `SchemaFenceError`; a write from a stale-schema client after completion throws `MigrationRequiredError`.
3. `hub.writeQueue.onFlush()` is the quiesce primitive and is independently usable for `beforeunload`/lock guards.
4. Zero new presence/heartbeat or plaintext-bypass subsystems — all coordination reuses `by-peer`, `Collection.presence()`, and encrypted `_meta`.
5. Apps that never migrate incur no bundle cost from the migration subsystem.

## 8. Open items deferred to slice plans (not epic blockers)

- Exact admin-trigger API surface (method name, auth gate) — settle in Slice 2 plan.
- `activePeers` reactivity cadence vs. heartbeat TTL — settle in Slice 3 plan.
- Whether `withMigrations()` validates `from`/`to` contiguity across multiple registered migrations — settle in Slice 2 plan.
