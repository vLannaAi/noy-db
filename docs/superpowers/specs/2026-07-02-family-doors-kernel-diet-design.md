# Family doors, kernel diet & interface manifest (S5)

> **Status:** design (2026-07-02), approved by owner. Follows the canonical lexicon
> (`2026-07-01-noydb-architecture-lexicon.md`) and the S4 service-layer design
> (`2026-07-01-service-layer-withx-design.md`). Terminology: **service / service layer**
> (never "subsystem"), **pod** (never "bundle" for a serialized vault), **door** (a named,
> golden-frozen contract surface).

## Problem

The microkernel refactor (S1–S4) organized the *implementation* but left the *interface*
unbounded and unnamed:

1. **No microkernel interface document exists.** The root barrel (`src/index.ts`) exposes
   ~816 symbols with no ceiling and no golden test. Only `/kernel`, `/cargo`, `/adapter`,
   `/pod` are golden-frozen. The contracts that `on-*`, `at-*`, `in-*`, `as-*` satellites
   bind (`UnlockedKeyring`, `SealingKeyProvider`, `Noydb` types, `diffVault`…) are loose
   root-barrel exports.
2. **Names don't match the lexicon.** The store contract lives at `/adapter`; "bundle"
   survives in ~120 symbol uses (`writeNoydbBundle`, `NoydbBundleStore`, …) although the
   lexicon renamed the concept to **pod**.
3. **~5,300 LOC of secondary features still live in `kernel/`** (store plumbing, backup,
   envelopes, policy, join/live, coordination default, forget) — ranked in the 2026-07-02
   kernel review.
4. **~468 comment lines narrate history** (issue numbers, "Phase 5", "moved from X") instead
   of stating current contracts — noise that misleads both humans and agents.
5. **The enclave has no frozen interface** — no barrel exists; 47 import sites reach into
   `kernel/enclave/` internals directly. A forked sister project (nit-db) cannot swap the
   enclave safely.

## Decision — contract-per-family doors

Each satellite family binds **exactly one named contract** — a **door** — named by the
family's preposition, as both a folder and a published subpath. The kernel's outward
interface becomes a countable set of doors, each with a barrel + golden-surface test
(same machinery as `/cargo`).

### The door table

| Subpath | Physical home | Bound by | Content | Supersedes |
|---|---|---|---|---|
| `/to` | `kernel/to/` | `to-*` stores (incl. noy-db-to) | `NoydbStore` (6 methods) + `NoydbPodStore` + envelope/snapshot/op types + store errors; door-local impl: `memory-store.ts`, `sync-policy.ts` | `/adapter` |
| `/on` | `kernel/on/` | `on-*` unlock | `UnlockedKeyring`, `Role`, `Permissions`, `SlotRewrapContext`, `EnrollAuthenticatorOptions`, `PaperRecoveryEntry` + `mintPaperRecoveryEntry` | loose root exports |
| `/at` | `kernel/at/` | `at-*` sealing | `SealingKeyProvider` + sealing option/result types | loose root exports |
| `/in` | `kernel/in/` | `in-*` frameworks | type views of `Noydb`/`Vault`/`Collection`/`Query`/`LiveQuery` + `ChangeEvent` + subscribe surface types | loose root exports |
| `/by` | `kernel/by/` | `by-*` transports | `CoordinationProvider`, `FenceState`, `WriterPresence`, `DrainBarrierOptions` + `isQuorum`/`runDrainBarrier` + the envelope slice transports need | `/kernel` (already deprecated) |
| `/ui` | `kernel/ui/` | noy-db-ui | the `describe()` contract (`CollectionDescription` etc.) | `/describe` |
| `/with` | `kernel/with/` | `with-*` services (internal) | `service-bus.ts` (was `subsystem-bus.ts`), `write-hooks.ts`, `capabilities.ts` — the seam services hook into | loose kernel top-level files |
| `/as` | `src/as/` (**layer door**) | `as-*` exporters | `Vault` type view, `diffVault` + `VaultDiff`, pod header read/write (`readPodHeader`, `writePod` options) | loose root exports |
| `/cargo` | `src/with-cargo/` (**layer door**) | klum-db lobby | unchanged | ✓ already golden |
| `/pod` | `src/with-pod/` (**layer door**) | klum-db, backup consumers | unchanged (symbols renamed, see N1) | ✓ already golden |

Plus the **root barrel** (app-developer API) and the **enclave barrel** (fork contract) —
both golden-frozen by this cycle. Total: **10 doors + root barrel + enclave**.

### Two door kinds

- **Kernel doors** (`to on at in by ui with`) live in `kernel/<name>/`. They may import the
  kernel spine and their own door-local implementation. They must not import each other.
  Where a contract's definitions currently live in a service (`UnlockedKeyring` in
  `with-party/team`, the describe types in `with-shape/introspection`), the door re-exports
  them from there — a door is a *view*, and importing a door is itself the opt-in, so this
  costs nothing in tree-shaking. The binding restriction is on the **spine**, not the doors.
- **Layer doors** (`as cargo pod`) live in the service layer, because their implementation
  is service code (`diffVault` in `with-cargo`, pod format in `with-pod`). They may import
  services and the spine. The kernel never imports them.

### The layering law (enforced)

**Imports point inward only:** `family → door → service layer → kernel spine → enclave`.

- The kernel **spine** (`noydb.ts`, `vault.ts`, `collection.ts`, `query/`, `types.ts`,
  `errors.ts`, `schema.ts`, `refs.ts`, `validation.ts`, `collection-config.ts`, `cache/`,
  `util/`, `write-queue.ts`) may import `kernel/with/` (the hook seam) and `enclave/` —
  never a door folder other than `with`, never `with-*` services (except via the S4
  dynamic-import gates already in place).
- Door folders may not import each other.
- Everything outside `kernel/enclave/` imports the enclave **only via its barrel**
  (`kernel/enclave/index.ts`).

New checks in `scripts/check-architecture.mjs`:
- `door-layering` — the import-direction rules above.
- `enclave-barrel-only` — no deep imports into `kernel/enclave/`.

### Tree-shaking and gates

- **Unused door ⇒ dropped.** Because the spine never imports doors, a door is reachable
  only from its subpath, the root barrel re-export, or a service's dynamic import. With
  `sideEffects: false`, a consumer that never touches `as-*` sheds `/as` entirely. Absence
  of imports is the mechanism; no new runtime machinery.
- **Service → door dependency: no gate needed.** A service's `active.ts` dynamically
  imports what it needs (S4 recipe); opting in via `withX()` self-carries the dependency.
- **Spine method fronting a door/service: S4 ② gate.** Methods like `vault.dump()` /
  `exportJSON()` whose implementation is door/service territory use the existing recipe —
  `NO_X` stub throwing `XNotEnabledError` naming the exact `withX()` to add, real impl
  behind dynamic import.

### What stays in the kernel (the spine — not distributable)

`noydb.ts / vault.ts / collection.ts / query (basic) / types / errors / schema / refs /
validation / collection-config / cache / util / write-queue` + `enclave/`. Every door
exposes a *view* of these; assigning them to one door would force duplication. End-state
kernel = **spine + enclave + seven door folders**, nothing else.

## Naming decisions (locked)

| Old | New | Compat |
|---|---|---|
| `/adapter` subpath | `/to` | `/adapter` kept as deprecated alias (like `/kernel`→`/cargo`); noy-db-to migrates at next publish (#552 scope grows) |
| `/describe` subpath | `/ui` | `/describe` kept as deprecated alias |
| `/store` subpath (plumbing) | **removed** | plumbing exports remain on the root barrel only (owner-approved pre-1.0 break; no satellite imports `/store` — verified) |
| `wrapBundleStore` / `createBundleStore` | `wrapPodStore` / `createPodStore` | deprecated aliases |
| `writeNoydbBundle` / `readNoydbBundle` / `readNoydbBundleHeader` | `writePod` / `readPod` / `readPodHeader` | deprecated aliases |
| `NoydbBundleStore` / `WrappedBundleNoydbStore` / `NoydbBundleHeader` | `NoydbPodStore` / `WrappedPodNoydbStore` / `NoydbPodHeader` | deprecated type aliases |
| `BundleVersionConflictError` | `PodVersionConflictError` | deprecated alias (class extends/re-export, `instanceof` must keep working for old name) |
| `BUNDLE_STORE_POLICY` | `POD_STORE_POLICY` | deprecated alias |
| `subsystem-bus.ts` / `SubsystemBus` | `kernel/with/service-bus.ts` / `ServiceBus` | deprecated type/value alias |
| "subsystem" (comments/docs) | "service" | terminology sweep; `SUBSYSTEMS.md` → `SERVICES.md` with all cross-references updated |

**Exempt from bundle→pod:** the JS bundle-size CI gate, `bundle-manifest.json`, "bundler"
— JS bundling is a different word and keeps its name. The `.noydb` file extension is
unchanged.

**Deprecated-alias policy:** aliases carry `@deprecated` JSDoc naming the replacement;
removal is deferred to a coordinated version bump (never silently).

## Comment policy (N3)

A comment states the **current** contract or constraint — never the journey. Delete or
rewrite every evolution-narration fragment: issue-number breadcrumbs (`#469`), phase
references (`Phase 5 A4`), move/rename stories ("moved from X", "formerly", "renamed
from"), spec-section pointers that no longer teach anything (`spec §10`). Git history
holds the archaeology. ~468 matched lines, worst offenders `collection.ts` (71),
`vault.ts` (55), `types.ts` (23). Semantically a no-op: zero code changes in this phase.

## Interface manifest (M / M2)

- `kernel-api-surface.golden.test.ts` — enumerates the public (non-`_`-prefixed) prototype
  methods + getters of `Noydb`, `Vault`, `Collection` in `kernel-api.golden.json`. Any
  add/remove requires a visible baseline edit.
- `root-barrel-surface.golden.test.ts` — full export enumeration of `src/index.ts`
  (values + types, same mechanism as the existing four goldens). Expected to shrink over
  time; every change is a reviewed baseline edit.
- One golden per new door (`to-surface.golden.json`, `on-…`, `at-…`, `in-…`, `by-…`,
  `ui-…`, `with-…`, `as-…`).
- **M2 — enclave contract:** create `kernel/enclave/index.ts` (the fork-swap interface: crypto
  ops, record codec, sealing, key lifecycle, deterministic/tombstone helpers), migrate all
  47 external import sites to the barrel, add `enclave-surface.golden.json` +
  `enclave-barrel-only` check. The enclave is swapped **at fork/source level** — a sister
  project replaces the folder honoring the barrel; no build flag, no runtime injection.

## Extractions in this cycle (from the 2026-07-02 ranked review)

- **E1 (rank 1, ~1,580 LOC):** `kernel/store/route-store.ts` + `store-middleware.ts` → new
  `src/with-store/` service (root-barrel exports only); `bundle-store.ts` →
  `with-pod/pod-store.ts` (renamed as it moves). `memory-store.ts` + `sync-policy.ts` stay
  (door-local impl of `/to`). Verified zero call sites from the spine.
- **E2 (rank 7, ~136 LOC):** `coordination/store-provider.ts` → `with-shape/schema-update/`
  (its only consumer); kills the kernel→service import inversion. Port types stay, moving
  to `kernel/by/`.
- **E3 (rank 4, ~414 LOC):** `kernel/meta/public-envelope/` → `with-party/directory/`.

Deferred (own future efforts): user-envelope (rank 3), policy (rank 5), join/live seam
(rank 6), `forget()` (rank 8), enclave completeness audit + security review (#551 core).

## Phases (each its own PR, suite pinned green)

1. **E1** — evict store plumbing; pod-store rename folded in.
2. **N1** — bundle→pod symbol sweep + aliases.
3. **N2a** — kernel doors with impl moves: `to` (adapter contract + memory-store +
   sync-policy), `by` (coordination types + helpers), `ui` (describe), `with` (bus/hooks/
   capabilities, `ServiceBus` rename). Subpaths, aliases, goldens, `door-layering` check.
4. **N2b** — type-slice doors `on`, `at`, `in` + layer door `as`. Goldens.
5. **E2** — coordination default provider → with-shape.
6. **E3** — public-envelope → with-party/directory.
7. **M** — kernel-API manifest + root-barrel golden.
8. **M2** — enclave barrel + golden + `enclave-barrel-only` + migrate 47 import sites.
9. **N3** — comment de-blurping + subsystem→service terminology + `SUBSYSTEMS.md` →
   `SERVICES.md` + docs/lexicon/features.yaml sync.

Ordering rationale: E1 frees the `store` name space before N2a claims `/to`; goldens (M)
come after all moves so we freeze the final state, not churn; N3 last because it is
semantically inert and touches everything.

## Validation (every phase)

- `pnpm turbo test --concurrency=1 --filter '!@noy-db/showcases'` — the full cross-package
  suite (the hub-API-change rule; hub-only validation is insufficient).
- `pnpm check:architecture` (including the new checks once added) and `pnpm typecheck`,
  `pnpm lint`.
- Existing golden suites must pass unchanged until the phase that intentionally edits them.

## Success criteria

- Ten doors, each with a barrel and a golden test; root barrel and enclave golden-frozen;
  kernel API (Noydb/Vault/Collection methods) golden-frozen.
- `check:architecture` enforces `door-layering` and `enclave-barrel-only`.
- ~2,100 LOC leave `kernel/` (E1+E2+E3); kernel = spine + enclave + door folders only.
- Zero "bundle"-named canonical symbols for the pod concept (aliases only); zero
  "subsystem" wording; zero history-narrating comments in `src/**`.
- All satellites and sister repos keep working against the published package via the
  deprecated aliases; their migration is publish-gated (#552).

## Out of scope

- Satellite/sister-repo migrations to the new doors (publish-gated, #552).
- Enclave interface completeness audit + security review (#551).
- Extraction ranks 3, 5, 6, 8 (user-envelope, policy, join/live, forget).
- Any `features.yaml` schema changes (content sync only).
