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
| `SchemaUpdateStrategy` family (`coordinatedCutover`/`additiveOnly`/…) / `withBilingualFields()` | **Do not exist** — new in this epic | — |

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
| Subsystem name | **`update`** — import `@noy-db/hub/update`, per-collection `schemaUpdate: [...]` | Framed as "schema update" for app authors, not DB-migration jargon |
| Evolution model | **Open, pluggable update *strategies* — NOT a fixed tier ladder** | Coordinated cutover is one strategy among many; new strategies need no core change |
| Strategy composition | **Stackable, ordered per collection; first non-`allow` decision wins** (middleware) | `allow` = fall through; `reject`/`cutover` = terminal & short-circuit |
| Detection baseline | **Reuses `persisted-json-schema` (opt-in per collection)** | Strategies only fire where `persistJsonSchema: true`; no new persistence cost |

Trust model: all clients run our code (known-client deployment). A malicious/buggy client *could* bypass the cooperative fence; in this deployment that is a non-threat. The hardening path (an `at-*` sealing host refusing to unseal write credentials while the fence is up) is documented for untrusted-client scenarios but explicitly out of scope for this epic.

### 3a. Open update-strategy model (mechanism, not policy)

Schema evolution is **not** a closed 0/1/2 ladder. It is an **open family of pluggable update strategies**, exactly like guards / derivations / materialized-views: the hub core provides a *seam*, strategies provide *behavior*, and you bundle only the strategies you import. "Coordinated cutover" is one member of that family, not the whole subsystem.

**Always-on core provides only two cheap primitives:**

1. **Detection** — at `collection()` registration, diff the new schema against the `persisted-json-schema` baseline (canonical JSON Schema under `_schemas/<col>`, already hash-compared on registration) to produce a `SchemaDelta` (`none` / `additive` / `non-additive`, plus field-level adds/removes/changes). No version fields — single-step (§4) means the generation counter lives in the fence, not the delta.
2. **Dispatch** — feed that delta through the collection's ordered strategy list and act on the winning decision.

```ts
interface SchemaUpdateStrategy {
  readonly name: string
  onSchemaDelta(delta: SchemaDelta, ctx: UpdateContext): UpdateDecision | Promise<UpdateDecision>
}

type UpdateDecision =
  | { action: 'allow' }                                  // no objection — fall through to next strategy
  | { action: 'reject'; error: Error }                   // terminal: refuse the schema change
  | { action: 'cutover'; transform: TransformFn }        // terminal: run a coordinated drain-barrier
  // open — new terminal actions can be added without breaking existing strategies
```

**Bundled strategies (each tree-shakeable, importable on its own):**

| Strategy | `onSchemaDelta` behavior |
|---|---|
| *(empty list / none)* | accept the change — blind, back-compat default |
| `blindUpdate()` | always `allow` (explicit blind) |
| `lockSchema({ fields? })` | `reject` any change (optionally only when listed `fields` change) |
| `additiveOnly()` | `allow` additive; `reject` non-additive — the safety backstop |
| `coordinatedCutover({ transform })` | `allow` on additive/none; `cutover` on a non-additive delta (single-step — no `from`/`to`) |
| *future:* `lazyUpcast()`, `minVersionGate()`, `dualWrite()`… | each a new plugin — **no core change** |
| **custom** | implement `SchemaUpdateStrategy` |

The heavy drain-barrier machinery (fence, drain, `by-peer` election, bulk transform, `SchemaFenceError`/`MigrationRequiredError`) lives **inside the `coordinatedCutover` strategy package** — it is no longer "the subsystem," just one plugin. Every other strategy is tiny.

**Evaluation semantics (the core's contract — must be specified and tested):**

- The per-collection list is evaluated **in order**, awaiting each (decisions may be async).
- A strategy returning `{ action: 'allow' }` means "I have no objection" → continue to the next strategy.
- The **first** strategy returning a non-`allow` decision (`reject` or `cutover`) **wins and short-circuits** — later strategies do not run.
- If **all** strategies return `allow` (or the list is empty / `persistJsonSchema` is off) → the schema change is accepted.
- **Order is the only precedence.** To make a freeze beat a cutover, put `lockSchema()` first. No implicit ranking between action types.

This composition is what makes the open model powerful. Example — handle the known break, reject every *unknown* break:

```ts
vault.collection('invoices', {
  persistJsonSchema: true,
  schemaUpdate: [
    lockSchema({ fields: ['id', 'createdAt'] }),  // never let keys change
    coordinatedCutover({ transform }),            // migrate the break we have a transform for
    additiveOnly(),                               // backstop: any other break is refused
  ],
})
```

A non-additive change you *forgot* to write a `coordinatedCutover` for falls through to `additiveOnly()` and is **rejected loudly** — closing the "silent corruption" gap without a closed tier enum.

**Known limitation (accepted):** detection needs the persisted baseline, so on a collection without `persistJsonSchema: true` the strategy list never fires and any change is accepted (blind). The safety is opt-in, consistent with how schema persistence works today. Recommending `persistJsonSchema: true` for evolving collections is a Slice 2 docs deliverable.

## 4. The `coordinatedCutover` strategy (#232 architecture, the destination)

This section specs the **`coordinatedCutover` update strategy** (§3a) — the heaviest member of the open strategy family and the headline of the epic. A cooperative, eager, **single-step** drain barrier built entirely on existing machinery. It is one plugin behind the `{ action: 'cutover' }` decision; the core only knows the strategy interface, not this protocol.

**Single-step** (locked decision): migrations are coordinated fleet events — the whole fleet moves `current → next` together; no client is ever more than one generation behind. This means **no user-declared schema version**: the version is an opaque, **hub-managed monotonic generation counter** that the hub bumps on each completed cutover. `coordinatedCutover({ transform })` takes **no `from`/`to`** and needs no delta-matching — it fires on the one pending non-additive break that #245 detection surfaces for its collection.

### Fence document (encrypted, post-unlock only)

```
_meta/schema-fence  (encrypted, reuses _meta/policy load/save/cache)
  {
    currentSchemaVersion: number,                                   // hub-managed; vault-level "generation"
    fenceState: 'normal' | 'draining' | 'migrating' | 'complete'
  }
_meta/schema-fence/clients/<clientId>  (per-client quiesce acks + heartbeat — sub-slice 2b)
```

`currentSchemaVersion` is **vault-level** (one "app generation" counter), while change **detection is per-collection** (#245). A cutover runs every collection's pending transform in one drain, then bumps the single counter. No per-collection/per-vault contradiction: the counter means "generation," not "per-collection schema rev."

### Client version snapshot (how staleness is detected without a declared version)

On vault-open, a client **snapshots** `fence.currentSchemaVersion`. The write gate compares that snapshot to the live counter:

- snapshot **==** live → writes proceed (subject to fence state).
- snapshot **<** live → a cutover completed under a still-running client → `MigrationRequiredError` on the next `put`/`delete` → the app reloads.

A freshly-opened **old-code straggler** (started after a cutover, running stale code) is a different case: it snapshots the *new* counter but its validator expects the *old* shape, so it fails **loudly on read-validation** of already-transformed records. That's acceptable and documented — it does not get the graceful `MigrationRequiredError`, it gets an obvious read error telling the operator to update the client.

### Protocol

```
collection() registration (per client):
  snapshot fence.currentSchemaVersion at vault-open
  #245 detects a non-additive delta + coordinatedCutover registered
    ──▶ collection enters CUTOVER-PENDING; writes throw SchemaFenceError; transform registered

admin triggers cutover            ──▶ fenceState: 'draining'
  each active client:
    await hub.writeQueue.onFlush()        ← Slice 1 primitive
    refuse new user writes (throw SchemaFenceError)
    [2b] ack quiesced into _meta/schema-fence/clients/<id>
[2b] all active clients quiesced (or timeout) ──▶ fenceState: 'migrating'
  [2b] by-peer Web Locks elects ONE client; [2a] single client is trivially the migrator
  migrator runs every pending coordinatedCutover transform over all records, in bulk
  updates each collection's persisted-schema baseline to the new shape
  appends ledger op:'migration'           ← existing LedgerStore.append
complete                          ──▶ fenceState: 'complete', currentSchemaVersion bumps
  clients with snapshot < new counter → MigrationRequiredError on next write → reload
```

### Registration API

`coordinatedCutover` is one **update strategy** (§3a), declared in a collection's ordered `schemaUpdate` list. No `from`/`to` (single-step):

```ts
import { coordinatedCutover, additiveOnly } from '@noy-db/hub/update'

vault.collection('invoices', {
  persistJsonSchema: true,
  schemaUpdate: [
    coordinatedCutover({
      transform: (doc) => ({
        ...doc,
        amount: { gross: doc.totalAmount, currency: 'THB' },
        totalAmount: undefined,
      }),
    }),
    additiveOnly(), // backstop: any OTHER non-additive change with no cutover is rejected
  ],
})
```

Eager dispatch only: on a **non-additive** delta, `coordinatedCutover` returns `{ action: 'cutover', transform }` → the collection enters cutover-pending and the transform runs (in bulk) during the next `migrating` phase. On an additive/none delta it returns `allow` (falls through). Strategy handles follow the existing `with*()` → strategy-handle → `_init*()` registry convention.

### Error classes

A shared `SchemaUpdateError` base, with:

| Class | Thrown when | Home |
|---|---|---|
| `NonAdditiveSchemaChangeError` | A strategy's `reject` decision fires on a non-additive delta (e.g. the `additiveOnly()` backstop) | `additiveOnly()` strategy |
| `SchemaFenceError` | Write attempted while `fenceState ∈ {draining, migrating}` | `coordinatedCutover` strategy |
| `MigrationRequiredError` | Write attempted by a client whose **open-snapshot** of `currentSchemaVersion` is **<** the live counter (a cutover completed under it) | `coordinatedCutover` strategy |

(`SchemaVersionStaleError` from the original issue is **not** needed — eager-only eliminates mixed-version reads. `lockSchema()` rejects with its own `SchemaLockedError`, also extending `SchemaUpdateError`.)

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

### Slice 2 — schema-update strategy framework  *(#245, SHIPPED)*

Core `SchemaDelta` detection + dispatch + the light strategies (`blindUpdate`/`lockSchema`/`additiveOnly`), with `reject` enforced at the write path. Merged to `main`. This is the foundation `coordinatedCutover` plugs into; the `{ action: 'cutover' }` decision is typed but unreachable until Slice 3 wires it.

Docs deliverable (carry into the cutover slice): surface the blind-default limitation (no strategy / no `persistJsonSchema` ⇒ changes accepted unchecked) and recommend `persistJsonSchema: true` + at least `additiveOnly()` for any evolving collection.

### Slice 3 — `coordinatedCutover` strategy (#232, the headline)

The drain-barrier. Won't TDD like #227/#245 — its core is distributed — so it splits along the **testability boundary**:

- **Sub-slice 3a — single-client mechanics (deterministic, most of the value):** the `_meta/schema-fence` doc (modeled on `_meta/policy`), the hub-managed counter + open-snapshot, the write gate (`SchemaFenceError` while `fenceState ∈ {draining,migrating}`; `MigrationRequiredError` when snapshot < live counter), the `coordinatedCutover` strategy returning `{action:'cutover'}` on a non-additive delta, cutover-pending collection state, the bulk transform + persisted-baseline update + counter bump + ledger `op:'migration'`, and an admin trigger that runs the whole thing locally (one client = trivially the migrator). All testable in-process with the memory adapter. Extends `SchemaUpdateGate` to act on `{action:'cutover'}` (today it only acts on `reject`). Adds `'migration'` to the ledger `op` union.
- **Sub-slice 3b — distribution (smaller, harder):** presence-driven multi-client quiesce + per-client acks, real `by-peer` Web Locks election among N clients, heartbeat staleness drop-out, cross-client fence-state propagation. Requires an **in-process N-client harness** (shared memory store + in-memory `BroadcastChannel` + stubbed `MinimalLockManager`) — settled before writing the 3b plan.

No UI in either sub-slice (CLI/programmatic trigger is fine for tests). UI is Slice 4.

### Slice 4 — #233 reactive fence-state + Vue UI

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
5. Apps that import no update strategy incur no bundle cost from the `update` subsystem (the core detection/dispatch seam is the only always-on cost, and only does work when `persistJsonSchema` is on).
6. With `persistJsonSchema: true` and `schemaUpdate: [additiveOnly()]`, a non-additive change is detected at registration (the baseline is NOT overwritten) and **refused on the next `put`/`delete`** with `NonAdditiveSchemaChangeError`; an additive change passes. (`collection()` is synchronous, so the rejection surfaces at the write path; tests can also await the schema-check drain for eager feedback.)
7. Strategy lists evaluate in order: given `[coordinatedCutover({ transform }), additiveOnly()]`, a non-additive break triggers a cutover, an additive change passes, and (with `coordinatedCutover` removed) the same break is rejected by the backstop — the first non-`allow` decision short-circuits the rest.
8. A custom `SchemaUpdateStrategy` implemented outside the hub composes in the same list with no core change.

## 8. Open items deferred to slice plans (not epic blockers)

- Exact admin-trigger API surface (method name, auth gate) — settle in Slice 2 plan.
- `activePeers` reactivity cadence vs. heartbeat TTL — settle in Slice 3 plan.
- What happens if two collections each have a pending `coordinatedCutover` when a single cutover is triggered — confirm the migrator runs both in one drain (intended) and the counter bumps once — settle in the 3a plan.
- The in-process N-client test harness (shared memory store + in-memory `BroadcastChannel` + stubbed `MinimalLockManager`) for the distributed sub-slice — settle before the 3b plan.
- Exact additive-vs-non-additive classification rules (e.g. is widening a union additive? is adding an optional field with a default additive?) — settle in Slice 2 plan; the classifier's ruleset is the core's contract.
- Whether a vault-level default strategy list exists (collections without their own `schemaUpdate` inherit it) and, if so, whether per-collection lists **replace** or **prepend** the default — settle in Slice 2 plan. Leaning replace (no merge) for simplest precedence.
- Whether strategy `onSchemaDelta` may run at points other than `collection()` registration (e.g. on write) — for now, registration-time only.
