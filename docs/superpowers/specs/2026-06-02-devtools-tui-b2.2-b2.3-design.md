# Devtools Inspector — B2.2 Records + B2.3 Write Monitor Design

> **Status:** Design (approved in brainstorming) — pre-plan
> **Date:** 2026-06-02
> **Track:** B (devtools inspector). Finishes the TUI: slices **B2.2** + **B2.3** (+ the B2.1 masked-passphrase tail).
> **Spec parent:** `docs/superpowers/specs/2026-06-02-devtools-inspector-b2-tui-design.md`
> **Builds on:** B1 (`@noy-db/in-devtools`) and B2.1 (`@noy-db/in-devtools-tui`), both merged on `main` (#269).

## What this is

The terminal inspector (B2.1) currently browses a vault's **structure** — vaults → collections → schema/stats. This slice finishes it by adding the two remaining read surfaces:

- **B2.2 — Records pane:** paged browsing of a collection's decrypted records.
- **B2.3 — Write Monitor:** a live, vault-wide view of writes as they commit, oriented around two questions the operator actually asks: *how long does a write take to land in the store?* and *are multiple users/tabs overlapping on the same data?*

Both are **read-only** consumers of public hub APIs (inherited B1 constraint) — no hub changes, already-unlocked data only.

## Goals

- Browse records of the selected collection without leaving the TUI, paged so large collections stay bounded.
- Watch writes commit in real time across the whole vault, attributed to a user, with overlap/conflict made visible.
- Surface **write-to-store latency** (the delay between a write command and its persistence) when the store is instrumented — gracefully dark when it is not.
- Mask the interactive passphrase prompt (the B2.1 tail).

## Non-goals

- Per-write latency keyed to a specific `docId`. `to-meter` measures **aggregate** per-method timing, not per-call; correlating a sample to one write would require a `to-meter` change. Out of scope — the Monitor shows aggregate put/delete/get p50·p99 instead.
- Editing of any kind; mutation stays out (read-only invariant).
- Cross-vault drill-in needing additional passphrases (still deferred, as in B2.1).
- Mouse support, theming, resize handling beyond ink defaults.
- A `to-probe`/sampling-rate UI; the Monitor consumes whatever the app already wired.

## ① B1 facade extension (`@noy-db/in-devtools`)

The Monitor needs two signals B1 does not yet expose. Both are read-only and public-API-only.

1. **Conflicts.** Add `subscribeConflicts(handler: (c: InspectorWriteConflict) => void): () => void`, wrapping `db.onWriteConflict`. `InspectorWriteConflict` re-exports the hub `WriteConflict` shape (`vault`, `collection`, `docId`, `action`, `baseV`, `v`, `ownV`) unchanged — already plain/serializable.
2. **Latency (optional).** Extend the factory to `createInspector(db, opts?: { meter?: MeterHandle })`. When a `MeterHandle` (from `@noy-db/to-meter`) is supplied, add `inspector.meterSnapshot(): MeterSnapshot | null`; without it, `meterSnapshot()` returns `null`. The inspector never wraps the store itself — the app owns metering; the inspector only reads the handle it is given.

`subscribe` (WriteEvent) and `records` already exist from B1 and are unchanged. The `Inspector` interface gains `subscribeConflicts` and `meterSnapshot`; `createInspector`'s second arg is optional, so B1/B2.1 callers are unaffected.

These additions ship with their own unit tests in `@noy-db/in-devtools` (conflict fan-out; `meterSnapshot` null-vs-present).

## ② B2.2 — Records pane (per-collection)

Records belong to one collection, so this lives in the **detail area** as a mode of the selected collection.

**Navigation.** The detail pane gains tabs — **⟨Schema⟩ Records** — cycled with `Tab` (`Schema` is today's B2.1 view). Entering `Records` for a collection loads its first page.

```
┌Vaults───┐┌Collections┐┌invoices ── Schema ⟨Records⟩ ────────────┐
│▸myvault ││▸ invoices ││ rows 1–20 of 142     (n/p page · ⇥ back) │
│ archive ││  customers││ id      amount   date        status      │
└─────────┘│  payments ││ inv001  1200.00  2026-01-03  paid        │
           └───────────┘│ inv002    42.50  2026-01-03  void        │
                        │ …                                        │
                        └──────────────────────────────────────────┘
```

- Paging via `inspector.records(vault, collection, { limit, offset })` → `RecordPage { rows, total, limit, offset }`. `n`/`p` step pages; the header shows `offset+1–min(offset+limit,total) of total`. Page size from config (`recordsPageSize`, default 20).
- **Rendering.** Columns are inferred from the collection's `fields` (the schema B2.1 already has). Each row prints those fields in declaration order; scalar values shown verbatim, non-scalar (objects/arrays) shown as a compact `{…}`/`[n]` placeholder. A row missing a field shows `·`.
- A new presentational `RecordsPane.tsx`; `App` owns `{ detailTab, page, offset }` state and key routing.

## ③ B2.3 — Write Monitor (global)

Multi-user overlap is a cross-vault concern, so the Monitor is a **top-level view**, not a per-collection tab. Key `w` enters it; `Esc` returns to structure browsing.

```
┌ Write Monitor — myvault ──────────────────  (w/esc · c clear · q quit) ┐
│ store  put p50 11ms p99 92ms ⚠degraded · del p50 4 p99 9 · get p50 3   │
│ ───────────────────────────────────────────────────────────────────── │
│ time      user    op   collection/docId    v                           │
│ 12:03:41  bob     put  invoices/inv204    2→3   ⚠ CONFLICT             │
│ 12:03:41  alice   put  invoices/inv204    2→3                          │
│ 12:03:39  alice   del  payments/p17       4→·                          │
│ 12:03:38  alice   put  invoices/inv203    0→1                          │
└────────────────────────────────────────────────────────────────────────┘
```

**Feed (always present).** A bounded ring buffer (newest on top, cap `monitorBufferSize`, default 200) fed by `inspector.subscribe` (WriteEvent) and `inspector.subscribeConflicts`. Each row: `timestamp` (HH:MM:SS from `WriteEvent.timestamp`), `userId`, `op` (`create`→`put`/`update`→`put`/`delete`→`del`), `collection/docId`, and `baseVersion→version` (`→·` on delete).

**Overlap & conflicts.** A write is flagged when a `WriteConflict` arrives for its `docId`, and visually when two buffered writes share `docId` + `baseVersion` from different `userId`s (the "two writers branched from the same base" signal). Conflicted rows are highlighted.

**Latency readout (light-up).** A one-line header from `inspector.meterSnapshot()`, polled ~1 s: per-method `p50`/`p99` for `put`/`del`/`get` and a `⚠degraded` marker when `to-meter` reports degraded status. This is the operator's "command → committed in the store" delay (`put` duration). When the store is not metered (`meterSnapshot()` returns `null`), the header line is omitted entirely — the feed still works.

**Lifecycle.** Subscriptions (`subscribe`, `subscribeConflicts`) start when the Monitor is first opened and persist for the session (so the buffer fills even while browsing structure); the latency poll runs only while the Monitor view is mounted. All unsubscribes run on quit.

## ④ B2.1 tail — masked passphrase prompt

The interactive prompt (used when no `--passphrase`/env is supplied) currently reads input unmasked. Replace it with a masked field (echo `•` per character, never the plaintext); the resolved passphrase is still used solely for `openVault` and never logged/persisted. Unit-tested with injected input.

## Architecture & state

`App` remains the single state owner; panes stay presentational.

```
App state additions:
  view: 'structure' | 'monitor'         # 'w' / Esc toggle
  detailTab: 'schema' | 'records'       # Tab cycles within structure
  records: { offset, page } | null      # current records page for the selected collection
  monitor: { buffer: FeedRow[], meter: MeterSnapshot | null, conflicts: Set<docKey> }

Effects:
  on first monitor open → inspector.subscribe(push) + inspector.subscribeConflicts(flag)
  while monitor mounted → interval(1s) → setMeter(inspector.meterSnapshot())
  on records tab/page → inspector.records(vault, coll, {limit, offset}) → setPage
  on quit → run all unsubscribes
```

New components: `RecordsPane.tsx`, `WriteMonitor.tsx` (feed + latency header), `PassphrasePrompt` masking. `App` gains the view/tab routing.

## Error handling

- `inspector.records` failure → an error line in the Records pane (no render crash); `n`/`p` remain usable to retry/step back.
- `subscribeConflicts`/`subscribe` handler throwing → caught per-event, surfaced as a dim `feed error` row; never tears down the subscription.
- `meterSnapshot()` throwing or returning `null` → latency header simply hidden.
- Read-only invariant holds: no path writes.

## Testing

`ink-testing-library` + an injected **fake inspector** (scriptable: emits chosen `WriteEvent`s/`WriteConflict`s, returns canned `RecordPage`s, and a togglable `meterSnapshot`):

- **Records:** `Tab` enters Records; first frame shows `rows 1–N of total` and the field columns; `n`/`p` change the page window; non-scalar value renders as `{…}`.
- **Monitor:** `w` enters the Monitor; scripted events appear newest-first; a `WriteConflict` highlights the matching row; two same-base writes from different users flag overlap; buffer caps at `monitorBufferSize`.
- **Latency light-up:** with a `meterSnapshot` present the header shows p50/p99 and `⚠degraded` at threshold; with `null` the header is absent.
- **Passphrase mask:** injected input echoes `•`, never the plaintext; resolved value reaches `openVault`.
- **Read-only:** a full Records + Monitor session does not mutate the store.
- B1 extension unit tests: `subscribeConflicts` fan-out/unsubscribe; `meterSnapshot` null-vs-present.

## Packaging / registry

- No new package — extends `@noy-db/in-devtools` (facade) and `@noy-db/in-devtools-tui` (UI).
- `@noy-db/to-meter` becomes an **optional** integration: a `devDependency` of `in-devtools` for the latency types/tests; the app supplies the `MeterHandle` at runtime. No new hard dependency on `to-meter`.
- Showcase: extend showcase 90 (or add 91) to exercise `inspector.records` + a scripted `subscribe`/`subscribeConflicts` round-trip headlessly (the TUI itself is proven via `ink-testing-library`, not a showcase).
- `features.yaml`: the existing `in-devtools` entry covers the facade; note the new capabilities in its description if the registry tracks methods.

## Follow-on

- **B3** — browser panel (Vue), the large visual slice; its own brainstorm → spec → plan with visual-companion mockups.
- Possible later: per-write latency (needs a `to-meter` change to tag samples), cross-session propagation-delay metric (time from commit in one tab to visibility in another).
