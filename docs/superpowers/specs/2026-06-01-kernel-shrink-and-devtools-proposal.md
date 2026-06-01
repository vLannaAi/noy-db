# Proposal: Kernel Shrink + Devtools Inspector

> **Status:** Proposal (high-level, two tracks) — pre-design
> **Date:** 2026-06-01
> **Author:** brainstorming session
> **Scope:** Two independent efforts, each gets its own design → plan → implementation cycle after this proposal is accepted.

This document sketches two enhancements and a recommended sequencing. It is deliberately high-level: each track below becomes its own focused spec before any code is written.

---

## Background: what the codebase already does well

noy-db is **not** a poorly-organized codebase. The package families are already clean:

| Prefix | Family | Examples |
|--------|--------|----------|
| `to-*` | storage destinations | `to-postgres`, `to-aws-s3`, `to-browser-idb` |
| `on-*` | authenticators / IdP bridges | `on-webauthn`, `on-password`, `on-oidc` |
| `at-*` | sealing-key providers | `at-aws-kms`, `at-env`, `at-macos-keychain` |
| `as-*` | export/import codecs | `as-csv`, `as-xlsx`, `as-noydb` |
| `in-*` | framework integrations | `in-react`, `in-vue`, `in-pinia` |
| `by-*` | session-share transports | `by-tabs`, `by-peer` |
| — | core + tooling | `hub`, `cli`, `attestation`, `create-noy-db` |

The hub itself is a **minimal-core + opt-in-subsystem** design (`SUBSYSTEMS.md`): 21 subsystems, each with a `with<Name>()` strategy factory, a subpath export, a doc page, and a CI bundle-size gate. Heavy subsystem implementations are `await import()`-ed lazily, so a `createNoydb({ store, user })`-only consumer tree-shakes them out.

**The families and the subsystem catalog do not need restructuring.** The two opportunities below are narrower and concrete.

---

## Track A — Shrink the kernel (architecture)

### The problem, precisely

Tree-shaking already removes subsystem *implementations* from the bundle. What it does **not** remove is subsystem *awareness* baked into the always-on kernel.

`collection.ts` (3,955 LOC) and `vault.ts` (3,526 LOC) are always-on orchestration objects that hard-code a private field and an inline dispatch branch for **every** subsystem:

```ts
// collection.ts — a sample of the always-on coupling
private readonly blobStrategy: BlobStrategy
private readonly aggregateStrategy: AggregateStrategy
private readonly crdtStrategy: CrdtStrategy
private readonly historyStrategy: HistoryStrategy
private readonly i18nStrategy: I18nStrategy
private readonly syncStrategy: SyncStrategy
private readonly periodGuard: ...
private readonly guardSource: ...
private readonly derivationSource: ...
private readonly materializedViewSource: ...
private readonly joinResolver: ...
```

`collection.ts` references `Strategy|Source|Resolver|Guard` **173 times**. Adding subsystem #22 means editing the kernel — an open/closed-principle violation. It is also why `SUBSYSTEMS.md` advertises a ~6,500-LOC core while the actual always-on root files total ~14k+ LOC (`collection.ts` 3,955, `vault.ts` 3,526, `noydb.ts` 2,722, `types.ts` 2,081, `errors.ts` 1,787). The bundle-size gates pass; the *kernel surface* aspiration has drifted from the code.

### The proposal

1. **Extension-point bus.** Generalize the three plumbing seeds that already exist — `NoydbEventEmitter` (`events.ts`), `WriteHookRegistry` (`write-hooks.ts`, #230), and `WriteQueueTracker` (`write-queue.ts`, #227) — into one named-lifecycle-point bus. Subsystems register handlers against named points instead of the kernel naming each subsystem:

   - Write path: `beforePut`, `afterPut`, `beforeDelete`, `afterDelete`
   - Read path: `onRead`, query-terminal hooks
   - Lifecycle: `onVaultOpen`, `onCollectionOpen`

   The kernel retains only: record CRUD, crypto envelope, the 6-method store contract, and the bus. Subsystem dispatch branches move out of `collection.ts`/`vault.ts` into the subsystems' own registration code.

2. **Complete the two splits `SUBSYSTEMS.md` already lists as open:**
   - **keyring-grant → `team`.** Move multi-user grant/revoke/rotate out of core so the floor is genuinely single-user.
   - **lazy-mode → its own subsystem.** Promote the cache + on-demand fetch path currently buried inside `routing`.

3. **Make the kernel claim CI-enforceable.** Add a kernel-surface invariant (alongside the existing bundle-size invariants) that fails CI if the always-on root grows past a declared ceiling, or if a new subsystem adds a hard-coded reference into `collection.ts`/`vault.ts`.

### Payoff vs. risk

- **Payoff:** the kernel stops growing per-subsystem; the catalog's "minimal core" claim becomes load-bearing on kernel surface, not just bundle bytes; `collection.ts`/`vault.ts` shrink to a size a single reader (human or model) can hold in context; subsystem #22+ is purely additive.
- **Risk:** this touches the hottest paths — every `put`/`get`/`delete`. It MUST be strictly behavior-preserving. Mitigation: the existing 107-showcase suite plus the ~1,600 hub unit tests are the regression net; migrate one lifecycle point at a time, each migration green before the next.

### Out of scope for Track A

- No new subsystems (that's Track B).
- No change to the public `createNoydb` / `with<Name>()` surface — this is an internal decomposition, not an API break. (If a break proves unavoidable, it escalates to its own decision.)

---

## Track B — Devtools / inspector (new feature)

### Why this matches a common developer pattern

Every adopter inspecting a noy-db vault today hand-rolls it: `console.log` on query results, manual `dumpSchema()` calls, eyeballing sync state. Mature data layers ship an inspector — Prisma Studio, Redux DevTools, React Query Devtools. Developers expect one.

### Why it is low-risk and well-seated

The inspector is almost entirely a **consumer** of seams that already exist:

- `vault.dumpSchema()` → `SchemaIntrospection`, `CollectionDescriptor`, `CollectionStats` (records, bytes, oldest/newest)
- live queries (`.live()` / `.subscribe()`)
- the observable write-queue (#227) and write hooks (#230)
- `to-probe` / `to-meter` store wrappers for backend timing/stats
- the `noydb describe` CLI (schema dump already wired)

It ships as a new package in the `in-*` family (`@noy-db/in-devtools`) plus an optional always-off `withInspector()` hook surface. **No kernel changes**, and it composes naturally with Track A's bus — the inspector becomes the canonical bus consumer.

### Two delivery modes (confirmed)

1. **Browser panel.** A framework-agnostic core that streams a read-only snapshot over the existing event surface, plus a browser UI:
   - vault → collection → record tree
   - schema + indexes + refs per collection
   - live query results with re-run
   - history timeline (when `withHistory` is on)
   - sync / write-queue state
2. **CLI / TUI mode.** Extends `noydb describe` into an interactive terminal inspector for headless / server / CI contexts (no browser).

### Hard constraints (zero-knowledge respect)

- **Read-only.** The inspector never writes through any path that isn't already a public, permission-checked API.
- **Already-unlocked only.** It shows decrypted data solely within an already-open session; it never handles passphrases, never touches ciphertext semantics, and never bypasses the keyring or permission checks.
- **No new always-on cost.** The hook surface is off unless `withInspector()` is opted into; the panel/CLI live in a separate package.

### Out of scope for Track B

- Editing data from the panel (read-only v1; mutation is a possible v2 behind explicit opt-in).
- Remote/production telemetry shipping (this is a local dev tool, not an observability backend — that's the reserved `metrics` subsystem).

---

## Recommended sequencing

**Track A first, then Track B.**

The inspector (B) is the ideal *first consumer* of the extension bus (A). If the bus lands first, the panel subscribes to named lifecycle points instead of reaching into kernel internals, and building the inspector validates the bus design against a real workload. Building B first would couple it to the current god-object surface and create rework when A lands.

| | Track A — Kernel shrink | Track B — Devtools inspector |
|---|---|---|
| Risk | High (hot paths) | Low (additive, consumer-only) |
| Touches kernel | Yes | No |
| Depends on | — | Track A's bus (soft) |
| Net LOC effect | Kernel shrinks | New `in-devtools` package |
| Sequence | **1st** | **2nd** |

---

## Next steps

1. Accept / revise this proposal.
2. Open the **Track A** design (`writing-plans`): enumerate every lifecycle point, the exact subsystem-by-subsystem migration order, and the kernel-surface CI gate.
3. After Track A ships, open the **Track B** design: the `in-devtools` package API, the snapshot protocol over the bus, browser panel UX, and CLI/TUI mode.

Each step gets its own spec → plan → implementation cycle. This document is the umbrella.
