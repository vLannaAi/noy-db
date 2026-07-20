# Via Phase D Implementation Plan (#650) — via-lookup: reference binding, three tiers, altKeys, vocabulary governance, ref semantics

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `via-lookup` — one via binding (brand `'lookup'`) that unifies the enum / dict / reference-collection tiers behind `lookup()`/`enum()`/`dict()` descriptors (with `dictKey`/`staticDict` preserved as byte-equivalent aliases), plus altKey ingest-normalization, open/closed vocabulary governance, backing choice (static table / reserved micro-collection / first-class collection), and `restrict|cascade|nullify` ref semantics through the phase-C graph. In doing so, close three structural defects: dictionaries never sync (#647), `DictKeyInUseError` never thrown (#648), `dictKey` membership validation documented-but-nonexistent (#649); and retire the #626 `join.ts → shape/via-i18n/core.js` grandfather so the `via-layering` allowlist ends **EMPTY**.

**Architecture:** `via-lookup` is a feature-layer binding under `src/shape/via-lookup/` reached ONLY through a new `port/with/lookup-strategy.ts` seam (mirroring `port/with/i18n-strategy.ts`) — the kernel spine never imports `shape/**` (Check 14 stays intact; the `port/with/` exception is the door, exactly as dict reaches `DictionaryHandle` today). The always-on core is untouched; the binding tree-shakes out for collections that declare no lookup field. The three tiers are one binding differing only by a `backing` detail: **enum** → a static in-config table (no store); **dict/reserved** → a reserved `_lookup_*`/`_dict_*` micro-collection that now participates in the mutation choke point (so it syncs and feeds the phase-C dispatch wave); **matrix** → a first-class collection (`countries`) reached by a cross-collection graph edge (`EdgeKind 'ref'`). Membership (`vocabulary: 'closed'`) validates at write time on the `enforceRefsOnPut` precedent through a **vault-built membership closure** (never a collection handle in `ViaWriteCtx`). A single **sync lookup snapshot + locale** seam (the `active.ts` materialization pattern) serves join-dressing, `compareForOrder`, and membership at once — and its sync per-collection present-for-join hook on `JoinableSource` is what lets `join.ts` drop the shape import.

**Tech Stack:** TypeScript, `@noy-db/hub` (tsup + vitest), turbo monorepo. Run from repo root: `pnpm vitest run <path>`; one package: `pnpm --filter @noy-db/hub <script>`.

## REQUIRED READING (every task)

- Spec (user-ratified): `docs/superpowers/specs/2026-07-12-via-phase-d-design.md`
- **Seam map (ground truth — AUTHORITATIVE over the spec where they conflict; conflicts flagged inline below):** `.superpowers/sdd/seam-map-lookup.md` — Part-N references point into it. Line numbers were located at `feat/650-via-phase-d` HEAD `c67368ea` (spec-only commit atop `main 9f29ea53`); re-locate by symbol if drifted.
- Phase-A/B/C conventions: `kernel/via.ts` (ViaBinding/ViaPosture/ViaCryptoCtx/ViaWriteCtx), `kernel/via-pipeline.ts` (`postureFor`/`redactForExport`/`ViaTaintOverlay`), `kernel/via-compose.ts` (`via()`/`mergeViaFields` — throws for non-money/i18n/computed/classified brands), `kernel/via-graph.ts` (`registerDerived`/`EdgeKind`/dispatch+erasure enumerations), `kernel/via-dispatch.ts` (`runGraphDispatchWave`/`forgetDerivedFanout`/`ForgetFanoutStats`), `port/with/i18n-strategy.ts` (the port-move precedent), the two via guard rules + allowlists in `scripts/check-architecture.mjs`.
- Phase-A/B/C plans for structure: `docs/superpowers/plans/2026-07-11-via-phase-c.md`.

## SEAM-MAP-vs-SPEC CONFLICTS (resolved here; re-flag if execution reveals more)

1. **Extraction target folder.** Spec §7 says the dict block leaves vault.ts "into `shape/via-lookup/` + port seams." Ground truth (seam map §9, check-architecture.mjs `PRE_EXISTING_SPINE_SERVICE_IMPORTS` at `:1329-1409`) shows the established vault-facade precedent (`VaultLinks`) lives in `with-shape/links/` and is grandfathered, while Check 14 bans `kernel → shape/**`. **Resolution:** mirror dict EXACTLY — feature code (handle engine, binding, descriptors, snapshot) lives in `shape/via-lookup/`, reached ONLY through a new `port/with/lookup-strategy.ts` seam (the `port/with/` exception is Check-9- and Check-14-legal, needs no grandfather); the vault-resident registry Maps stay vault-resident and arrive by reference (the "registries stay vault-resident … arrive by reference" pattern, ceiling comment `:815`). Do NOT create `with-shape/lookup/` — it collides three ways with the existing `with-lookup/` service folder and `shape/via-lookup/` (seam map §10).
2. **`ref('_target')` legality vs "a dictKey IS a ref."** The seed/`dictionary.ts:18-21` claim "a dictKey IS a ref to the dict collection," but `ref()` throws on `_`-prefixed targets (`refs.ts:142-147`) and `refs.test.ts:121-122` pins that. **Resolution:** the lookup binding reaches its reserved/collection backing through its OWN cross-collection graph edge (`EdgeKind 'ref'`, Task 5), NOT by relaxing `ref()`. `ref('_ledger')`/`ref('_history')` STILL throw; `refs.test.ts` is byte-unchanged. The "dictKey is a ref" idea is realized as a graph edge, not a `ref()` call.
3. **#647/#648/#649 "pin-flips" are near-empty.** Seam map §8 establishes these defect behaviors have **no** pinning tests (they are the listed coverage gaps). **Resolution:** the sanctioned per-file flips enumerated below are minimal-to-none; the real regression surface is **alias-equivalence** (dictKey/staticDict → lookup binding, byte-level) and **emitter-shape preservation** (`dict-emitter.test.ts`). Each task states its actual flip set (mostly "additive coverage, no flip").
4. **`compareForOrder` carries no locale (seam map surprise 6).** Label-sort short-circuits before `via.compareForOrder` today (`builder.ts:1343-1357`). **Resolution:** the snapshot+locale seam hands `compareForOrder` its snapshot via a binding closure — the hook **signature does not change** (Task 6); the plan generalizes the existing `resolveDictSource`/labelMaps channel rather than adding a ctx-bearing hook.

## Global Constraints (copied from spec §8 + arc conventions)

- **Behavior lock:** the FULL dict/i18n/join/refs/indexing suites (seam map §8 inventory — `dictionary.test.ts`, `dict-emitter.test.ts`, `dictkey-parity.test.ts`, `export-dict.test.ts`, `i18n-read-layer.test.ts`, `query-dictkey.test.ts`, `query-dictkey-label-sort.test.ts`, `search-retrieve-dictkey.test.ts`, `via/i18n-binding.test.ts`, `refs.test.ts`, `walk-closure.test.ts`, `query-join*.test.ts`, `query-join-i18n.test.ts` (the #626 lock), the `via/` graph/taint/dispatch/forget suites) pass **UNCHANGED**. **Alias equivalence is the primary lock:** `dictKey`/`staticDict` compiling onto the `'lookup'` binding must be byte-for-byte identical against today's dict suites (dedicated parity fixtures per alias per tier — Task 2). **Sanctioned exceptions (enumerated PER FILE in the task that flips them):** any test that pins a #647/#648/#649 *defect* behavior flips to pin the fix, using the phase-C pin-flip recipe (flip + self-commenting rationale line). Any test edit other than ADDING tests, or an enumerated flip, is a deviation to flag.
- **Zero-knowledge non-negotiable:** the membership closure is **vault-built** and threaded into the binding cfg as a `(key) => boolean | Promise<boolean>` — the binding never receives a `Collection` handle, keyring, DEK/CEK, or the enclave barrel. `ViaWriteCtx` stays narrow (`{id, vault, prior, emit}` — `via.ts:20-28`); no cross-collection read door is added to it. Reserved-tier crypto stays on `ViaCryptoCtx.reservedEnvelopes(prefix)` exactly as phase B built it (`sealed-slots.ts:228-268` — whole-DEK, no per-record CEK); `reservedEnvelopes`/`sealedSlots` are unchanged. The graph holds `(collection, field)` names, postures, grains ONLY — never keys or values.
- **Ceilings are EXACT-LOCKED at current values, then ratchet DOWN after extraction (verified at HEAD `c67368ea`):**
  - `kernel/collection.ts` — actual **4460**, ceiling **4473** (`check-architecture.mjs:728`), slack **+13**.
  - `kernel/vault.ts` — actual **4085**, ceiling **4088** (`:944`), slack **+3**.
  - `kernel/noydb.ts` — actual **2383**, ceiling **2385** (`:1052`), slack **+2**.
  Extraction (Task 1) MUST land first and re-ratchet vault.ts's ceiling DOWN to its post-extraction actual before any later task adds a kernel line. A genuine ratchet-UP is a BLOCKED decision requiring explicit user sign-off, never a silent bump. Report actual counts every task that touches a guarded file. Prefer new unguarded files (`shape/via-lookup/**`, `port/with/lookup-strategy.ts`) over the guarded spine.
- **Guards end-state:** `VIA_SHAPE_ALLOWLIST` (`via-layering`, `:1866-1871`) ends **EMPTY** (`new Map([])`) — Task 6 deletes `join.ts:51-52` and the Check 9 `join.ts → ['../../shape/via-i18n/core.js']` entry (`:1424-1426`) — and the guard must still FIRE on a synthetic `kernel/** → shape/**` import (the phase-B deletion recipe). `VIA_ENCLAVE_ALLOWLIST` (`:1922`) stays **EMPTY** and fires on a synthetic `shape/via-lookup/** → kernel/enclave` import. The enclave body-access ratchet for `shape/via-i18n/dictionary.ts` (pinned `3`, `:1683`) moves WITH the extracted engine (retarget the entry to `shape/via-lookup/handle.ts`, same count — no new enclave access). New `shape/via-lookup/**` reaches crypto only via `ctx`.
- **#553 discipline:** membership validation is write-path async (the write pipeline is already async — `via-pipeline.ts:36-38`; the `enforceRefsOnPut` precedent, seam map surprise 8). QUERY-participation hooks (`buildClause`/`evaluateClause`/`compareForOrder`/`decodeResults`) stay SYNC — served by the sync snapshot, never a store read. A collection declaring no lookup field keeps `this.via === undefined` (zero-via fast path, `via-pipeline.ts:29-33`) — the lookup binding must not appear in the floor bundle for such collections.
- **Bundle discipline:** run `pnpm --filter @noy-db/hub bundle-check` at the tasks that change compiled surface (Tasks 1, 2, 6, 7; build first — `NODE_OPTIONS=--max-old-space-size=8192` if DTS OOMs). The lookup binding + snapshot must stay OUT of the floor bundle for collections without a lookup field. Add a new bundle scenario if the countries-matrix warrants one (Task 7).
- **Never add Claude attribution** to commits/PRs/CHANGELOGs. **Grep every diff for "accounting-firm" before every commit** (`grep -rn "accounting-firm" <diff>`).

---

### Task 1: Extraction-first — move the dict registry/handle block out of vault.ts into `shape/via-lookup/` + a port seam; retire dead `applyLocale`; ratchet ceilings DOWN

**Rationale:** vault.ts has +3 slack; every later task adds wiring there. The ~350-line dict block is the fund. This task is a **pure relocation** — zero behavior change — locked byte-for-byte by the existing dict suites. It ships FIRST so the ceiling re-ratchets before any feature line lands.

**Files:**
- Create: `packages/hub/src/shape/via-lookup/handle.ts` — the `LookupHandle` class, a verbatim move of `DictionaryHandle` (`shape/via-i18n/dictionary.ts:319-708`) plus its `DictEntry`/`DictionaryOptions` types. Keep the class name aliased (`export { LookupHandle as DictionaryHandle }`) so existing importers compile unchanged this task.
- Create: `packages/hub/src/shape/via-lookup/registry.ts` — pure helper functions extracted from vault.ts's dict bodies: `enforceStaticDictOnPut(staticFields, record)` (from `vault.ts:1516-1538`), the `resolveDictSource` snapshot builder (from `vault.ts:1777-1816`), and the `findAndUpdateReferences` closure body (from `vault.ts:1655-1682`) as `updateReferencingRecords(registry, getCollection, name, oldKey, newKey)`. These take their state (the registry Maps, a `getCollection` fn) as ARGUMENTS — no `Vault` import.
- Create: `packages/hub/src/port/with/lookup-strategy.ts` — mirrors `port/with/i18n-strategy.ts`: the `LookupStrategy` interface (`buildLookupHandle(opts): LookupHandle`), `NO_LOOKUP` no-op, descriptor-type re-exports, `isLookupCollectionName`/prefix helpers. **This is the only lookup module vault.ts imports.**
- Create: `packages/hub/src/shape/via-lookup/active.ts` — `withLookup()` strategy factory returning the real `buildLookupHandle` (the `active.ts:34-58` pattern; the #553 tree-shake seam).
- Create: `packages/hub/src/shape/via-lookup/index.ts` — barrel.
- Modify: `kernel/vault.ts` — DELETE `enforceStaticDictOnPut` body, `resolveDictSource` body, the `dictionary()` `findAndUpdateReferences` closure body, and (RETIRE ENTIRELY) the dead `applyLocale` (`:1546-1612` — zero production callers, seam map surprise 11). Replace each with a thin delegator to `shape/via-lookup/registry.ts` (via the port seam) or a direct removal. The registry Maps (`dictKeyFieldRegistry`, `staticDictNames`, `staticByName`, `staticDescriptorByField`, `dictionaryCache` — `:393-438`) STAY vault-resident and pass by reference into the helpers.
- Modify: `shape/via-i18n/dictionary.ts` — re-export the descriptors (`dictKey`/`staticDict`/`DictKeyDescriptor`/`StaticDictDescriptor`) from here still (Task 2 rewrites them as aliases); the `DictionaryHandle` class body MOVES to via-lookup/handle.ts and this file re-exports it for one release.
- Modify: `shape/via-i18n/active.ts` + `port/with/i18n-strategy.ts` — `buildDictionaryHandle` now delegates to `buildLookupHandle` (same handle, new home).
- Modify: `scripts/check-architecture.mjs` — retarget the enclave body-access ratchet entry `shape/via-i18n/dictionary.ts → 3` to `shape/via-lookup/handle.ts → 3` (`:1678-1683`); add `../port/with/lookup-strategy.js` is NOT needed in vault.ts's grandfather (port/with is always allowed); ratchet `vault.ts` ceiling DOWN (Step 3).

**Interfaces — Produces (later tasks bind to these EXACT names):**

```ts
// port/with/lookup-strategy.ts
export interface BuildLookupHandleOptions<Keys extends string = string> {
  readonly adapter: NoydbStore
  readonly compartmentName: string
  readonly dimensionName: string
  readonly keyring: UnlockedKeyring
  readonly reservedEnvelopes: ReturnType<ViaCryptoCtx['reservedEnvelopes']>
  readonly encrypted: boolean
  readonly ledger: LedgerStore | undefined
  readonly options: LookupBackingOptions
  readonly findAndUpdateReferences: ((dimension: string, oldKey: string, newKey: string) => Promise<void>) | undefined
  readonly emitter: NoydbEventEmitter
  /** #647 (Task 4) — choke-point participation hooks; undefined in this task (pure move). */
  readonly onDirty?: (collection: string, id: string, action: 'put' | 'delete', version: number) => Promise<void>
  readonly onRecordMutated?: (collection: string, id: string, action: 'put' | 'delete', version: number) => Promise<void>
}
export interface LookupStrategy {
  buildLookupHandle<Keys extends string>(opts: BuildLookupHandleOptions<Keys>): LookupHandle<Keys>
}
export const NO_LOOKUP: LookupStrategy
export function isLookupCollectionName(name: string): boolean   // _dict_* OR _lookup_*
export const LOOKUP_COLLECTION_PREFIXES: readonly ['_dict_', '_lookup_']
```

**Interfaces — Consumes:** `NoydbStore`/`EncryptedEnvelope` (`kernel/types.ts`), `ViaCryptoCtx` (`kernel/via.ts:47-57`), `UnlockedKeyring`, `LedgerStore`, `NoydbEventEmitter`.

- [ ] Step 1 (RED = green-unchanged): make NO behavior change yet — this is a move. Run the FULL dict suite as the baseline lock BEFORE touching code: `pnpm vitest run packages/hub/__tests__/dictionary.test.ts packages/hub/__tests__/dict-emitter.test.ts packages/hub/__tests__/dictkey-parity.test.ts packages/hub/__tests__/export-dict.test.ts packages/hub/__tests__/query-dictkey.test.ts packages/hub/__tests__/i18n-read-layer.test.ts` — record the green count. Add ONE new file `packages/hub/__tests__/via/lookup-extraction-parity.test.ts` that imports `LookupHandle` from `shape/via-lookup/handle.js` and asserts `vault.dictionary('status').put/get/list/rename/delete` still round-trips + emits the `dict-emitter.test.ts` event shape (`{ vault, collection: '_dict_status', id, action }`) — RED (module absent).
- [ ] Step 2 (GREEN): perform the move — copy `DictionaryHandle` → `LookupHandle` (rename symbol, keep `DictionaryHandle` re-export), extract the three vault.ts bodies into `registry.ts`, create the port seam + `active.ts` + barrel, rewire `buildDictionaryHandle` → `buildLookupHandle`, DELETE `vault.applyLocale`. Confirm `applyLocale` truly has no caller: `grep -rn "\.applyLocale(" packages/hub/src packages/hub/__tests__` returns only its own definition (retire it) — if a caller exists, STOP and flag (contradicts seam map surprise 11). Run the recorded baseline suite → GREEN unchanged; the new parity file → GREEN.
- [ ] Step 3: **ceilings — vault.ts.** After the move `wc -l packages/hub/src/kernel/vault.ts` — it should drop by ~300+ lines. RATCHET the `vault.ts` ceiling in `check-architecture.mjs:944` DOWN to the new actual (a lower ceiling is always allowed) with a `#650 Task 1 (via-lookup extraction)` comment; leave collection.ts/noydb.ts ceilings unchanged (not touched). Retarget the enclave body-access ratchet (`:1683`) to `shape/via-lookup/handle.ts`. Run `node scripts/check-architecture.mjs` → OK. `pnpm --filter @noy-db/hub typecheck && pnpm --filter @noy-db/hub lint`. `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub bundle-check` (the moved engine must still tree-shake out of the floor). `grep -rn "accounting-firm"` the diff. Commit — `refactor(hub): extract dict registry/handle into shape/via-lookup + port seam; retire dead applyLocale; ratchet vault.ts ceiling down (#650)`.

---

### Task 2: The `'lookup'` binding + `lookup()`/`enum()`/`dict()` descriptors + three tiers; `dictKey`/`staticDict` become byte-equivalent aliases

**Files:**
- Create: `packages/hub/src/shape/via-lookup/descriptor.ts` — `lookup()`/`enum()`/`dict()` factories + `LookupDescriptor` (`_viaBrand: 'lookup'`).
- Create: `packages/hub/src/shape/via-lookup/binding.ts` — `lookupBinding(cfg): ViaBinding` (brand `'lookup'`) + `installViaBinder('lookup', …)` via `linkLookupVia()`. Present-time label dressing (adapted from `via-i18n/binding.ts:253-337`), `covers`, `posture`, `reservedPrefixes`, `describeFragment`. (Query hooks + membership land in Tasks 3/6.)
- Modify: `kernel/via-compose.ts` — `via()`/`mergeViaFields` accept the `'lookup'` brand (today throws for any non-money/i18n/computed/classified brand, `via-compose.ts:117-121`); route lookup descriptors into a `lookupFields` output map.
- Modify: `port/with/lookup-strategy.ts` — add `isLookupDescriptor`/`isEnumDescriptor` predicates + descriptor-type re-exports (the `i18n-strategy.ts:187-234` pattern).
- Modify: `shape/via-i18n/dictionary.ts` — rewrite `dictKey()`/`staticDict()` to CONSTRUCT `LookupDescriptor`s (reserved backing for dictKey, static backing for staticDict) while keeping their exact public return shape (`_noydbDictKey`/`_noydbStaticDict` + `_viaBrand`). The compat hinge: `mergeViaFields` must still compile a dictKey field into the binding that owns dict labels (seam map §1 "Extract/reuse/leave"). **Cleanest per spec §1:** the alias descriptors keep `_viaBrand: 'i18n'` for one release OR flip to `'lookup'` — DECIDE by which keeps `collection-config.ts:558-579`'s "one binding for i18nFields+dictKeyFields" intact. If dictKey moves to the lookup binding, i18nText-only collections must still compile their i18n binding and dictKey-only collections compile the lookup binding; a collection with BOTH compiles both. Verify with the parity fixtures.
- Modify: `kernel/collection-config.ts` — compile a `lookupBinding` for any collection carrying `lookupFields` (or dictKey/staticDict routed there); thread the config.
- Modify: `kernel/vault.ts` — build the `lookupBinding` cfg alongside the existing dict cfg wiring (`vault.ts:1138-1167`): a `lookupLabelResolver` (static table first, else reserved handle `resolveLabel`) + `getLookupBacking` factory. Thin additions only.
- Test: `packages/hub/__tests__/via/lookup-binding.test.ts` (new) + `packages/hub/__tests__/via/lookup-alias-parity.test.ts` (new — the alias lock).

**Interfaces — Produces:**

```ts
// shape/via-lookup/descriptor.ts
export type Vocabulary = 'open' | 'closed'
export type LookupBacking = 'static' | 'reserved' | 'collection'
export type OnDelete = 'restrict' | 'cascade' | 'nullify'   // default 'restrict' (Task 5)

export interface LookupDescriptor<Keys extends string = string> {
  readonly _viaBrand: 'lookup'
  readonly dimension: string                       // dimension/dictionary/target name
  readonly key: string                             // canonical key field on the row (default 'id')
  readonly altKeys?: readonly string[]             // candidate keys normalized to `key` on ingest (Task 3)
  readonly vocabulary: Vocabulary                  // 'closed' = enum semantics
  readonly present?: { readonly label: string; readonly by?: string }  // dressing dimension
  readonly sortBy?: string                         // compareForOrder against the snapshot (Task 6)
  readonly backing: LookupBacking
  readonly onDelete: OnDelete
  readonly keys?: readonly Keys[]                  // static/enum inline key set
  readonly table?: Readonly<Record<string, Readonly<Record<string, string>>>>  // static tier only
  readonly displayLocale?: string                  // static hybrid hinge (staticDict alias)
  readonly onMissing?: OnMissingPolicy
  readonly substitute?: readonly string[]
  readonly labels?: Record<string, string>
}

/** matrix tier — first-class collection backing (default backing 'collection'). */
export function lookup<Keys extends string>(
  dimension: string,
  opts?: { key?: string; altKeys?: readonly string[]; vocabulary?: Vocabulary;
           present?: { label: string; by?: string }; sortBy?: string;
           backing?: LookupBacking; onDelete?: OnDelete },
): LookupDescriptor<Keys>

/** enum tier — static in-config table, closed vocabulary, no backing store. */
export function enumOf<const Keys extends readonly string[]>(keys: Keys): LookupDescriptor<Keys[number]>
// NOTE: exported as `enum` is a reserved word — export `enumOf` and alias `export { enumOf as enum }` in the barrel.

/** dict tier — reserved micro-collection backing, open vocabulary by default. */
export function dict<Keys extends string>(
  dimension: string,
  opts?: { keys?: readonly Keys[]; vocabulary?: Vocabulary; present?: { label: string; by?: string };
           onMissing?: OnMissingPolicy; substitute?: readonly string[] },
): LookupDescriptor<Keys>

// shape/via-lookup/binding.ts
export interface LookupViaConfig {
  readonly lookupFields: Record<string, LookupDescriptor>   // field -> descriptor
  readonly lookupLabelResolver?: (dimension: string, key: string, locale: string, fallback?: unknown) => Promise<string | undefined>
  readonly membership?: (field: string, key: string) => boolean | Promise<boolean>   // Task 3, vault-built
  readonly snapshotFor?: (dimension: string) => ReadonlyMap<string, Record<string, unknown>> | undefined  // Task 6
  readonly collectionName: string
}
export function lookupBinding(cfg: LookupViaConfig): ViaBinding
export function linkLookupVia(): void
```

**Interfaces — Consumes:** `ViaBinding`/`ViaPosture`/`installViaBinder` (`kernel/via.ts`), `OnMissingPolicy` (`shape/via-i18n/policy.ts`), `via()`/`mergeViaFields` (`kernel/via-compose.ts`), `resolvePolicy`/`Layer` (`shape/via-i18n/policy.ts`).

Design notes:
- **Tiers are backing details of one binding.** `enumOf(['draft','sent','paid'])` → `{ backing:'static', vocabulary:'closed', keys:[…] }`; `dict('status')` → `{ backing:'reserved', vocabulary:'open' }`; `lookup('countries', {…})` → `{ backing:'collection' }` (default). The binding branches on `backing` for present/membership resolution only.
- **`posture`:** `{ encryptedAtRest:'envelope', queryable:'full', exportable:true, forgettable:false }` — codes are stored verbatim, plain equality queries work (seam map Part 4 `buildClause` row); nothing sealed. (A lookup INTO a classified collection folds that collection's posture via the graph — Task 5 taint composition, not this binding's own posture.)
- **`reservedPrefixes: ['_dict_', '_lookup_']`** — the reserved-backing door (Task 4).
- **Alias equivalence:** `dictKey('status', ['a','b'])` and `dict('status', { keys:['a','b'] })` produce descriptors that compile to the SAME binding with the SAME present/describe/emit behavior. `staticDict(name, table, {displayLocale})` → `{ backing:'static', table, displayLocale, vocabulary:'closed' }`. The parity file asserts byte-equality of stored record, `present()` labels, `describe()` output, and join dressing across the alias and the new form.

- [ ] Step 1 (RED): `lookup-binding.test.ts` — declare `status: dict('status')` and `state: enumOf(['draft','sent','paid'])`; assert (a) `via(lookup(...))`/`via(dict(...))`/`via(enumOf(...))` no longer throw in `mergeViaFields`; (b) `put`+`get` at a locale dresses `statusLabel` from the reserved handle, identical to a `dictKey` field; (c) an enum field stores the code verbatim and `describe()` reports `type:'enum'` + `widget:'select'`. `lookup-alias-parity.test.ts` — for the reserved tier and the static tier: same fixture declared once as `dictKey`/`staticDict` and once as `dict`/`lookup(static)`; assert `_getStoredRecord`, `present({locale})`, `describe()`, and a `.join()` dressing are byte-identical between the two. RED (descriptors/binding absent, via-compose throws).
- [ ] Step 2 (GREEN): implement the descriptors, `lookupBinding` (present dressing branch on `backing`, `covers`, `posture`, `describeFragment`), the via-compose brand acceptance + `lookupFields` grouping, the port predicates, the `dictKey`/`staticDict` alias rewrite, the collection-config compile, and the vault cfg additions. Run RED → GREEN. Run the FULL dict/i18n suites (Task 1 baseline) → GREEN unchanged (alias equivalence holds). `pnpm --filter @noy-db/hub typecheck`.
- [ ] Step 3: `pnpm check:architecture` (new `shape/via-lookup/**` imports no `kernel/enclave/**`; `via-compose.ts` imports no `shape/**` — route brand predicates through `port/with/lookup-strategy.ts`, mirroring how Task-11 of #623 moved `isDictKeyDescriptor` to the port to keep VIA_SHAPE_ALLOWLIST at one entry). Ceilings: collection-config.ts/vault.ts gained only cfg wiring — confirm vault.ts ≤ its Task-1 ratcheted ceiling and collection.ts ≤ 4473 (`node scripts/check-architecture.mjs`). `pnpm --filter @noy-db/hub build && bundle-check`. `grep accounting-firm`. Commit — `feat(hub): add via-lookup binding + lookup()/enum()/dict() descriptors, three tiers; dictKey/staticDict become aliases (#650)`.

---

### Task 3: altKeys ingest-normalization + open/closed vocabulary governance (fixes #649)

**Files:**
- Modify: `shape/via-lookup/binding.ts` — add `ingest(record)` (altKey → canonical-key rewrite, the money `canonicalizeIncomingMoney` precedent — SYNC, `via.ts:108`) and `enforceWrite(record, ctx)` (closed-vocabulary membership refusal via the vault-built closure — `via.ts:106`, awaited `via-pipeline.ts:36-38`).
- Modify: `shape/via-lookup/registry.ts` — `materializeBackingTable(descriptor, snapshot)` that computes the altKey→key index AND enforces declare-time uniqueness across `key ∪ altKeys` values (the CHE/SWZ drift class — collision → `ValidationError`).
- Modify: `kernel/vault.ts` — build the membership closure per lookup field and thread it into `LookupViaConfig.membership`. Static tier → in-memory key-set test (sync); reserved tier → snapshot-membership test (sync, from Task 6 snapshot; before Task 6 lands, use the reserved handle's `list()`-warmed cache); collection tier → `await backingCollection.get(key)` (the `enforceRefsOnPut` async precedent — `vault-facade.ts:113`). The closure is `(field, key) => boolean | Promise<boolean>`; it closes over vault state, so the binding never holds a collection.
- Modify: `kernel/errors.ts` — reuse `ValidationError`/`UnknownDictCodeError`; add `UnknownLookupKeyError extends NoydbError` (`'UNKNOWN_LOOKUP_KEY'`, carries `{dimension, field, key}`) for closed-vocabulary write refusal (distinct from staticDict's `UnknownDictCodeError`, kept for the alias's existing behavior).
- Test: `packages/hub/__tests__/via/lookup-vocabulary.test.ts` + `packages/hub/__tests__/via/lookup-altkeys.test.ts` (both new).

**Interfaces — Produces:**

```ts
// shape/via-lookup/registry.ts
export interface MaterializedBacking {
  readonly keys: ReadonlySet<string>                    // canonical keys
  readonly altIndex: ReadonlyMap<string, string>        // altKeyValue -> canonicalKey
}
/** Build the altKey index + enforce cross-key uniqueness. Throws ValidationError on collision. */
export function materializeBackingTable(
  descriptor: LookupDescriptor,
  rows: ReadonlyMap<string, Record<string, unknown>>,
): MaterializedBacking
```

**Interfaces — Consumes:** `LookupViaConfig.membership` (Task 2), `ViaWriteCtx` (`via.ts:20-28` — used only for `id`/`emit`, NOT for reads), `getAtPath` (`kernel/paths.ts`).

Design notes (per spec §3):
- **ingest** is pure record transform: for each lookup field, if the stored value matches an `altKeys` value, rewrite it to the canonical `key`. No store read (uses the materialized `altIndex` closed over the binding cfg). Idempotent (a canonical key maps to itself).
- **enforceWrite** runs only when `vocabulary === 'closed'`: `if (!(await cfg.membership(field, key))) throw new UnknownLookupKeyError(...)`. `'open'` permits unknown keys (skips the check). `upsertOnUse` is OUT of scope (spec §3, §"Out of scope").
- **#649 close:** this is the missing put-time validation the `dictKey` doc comment falsely claimed (seam map surprise 1). A `dict('status', { vocabulary:'closed' })` now rejects unknown keys; the DEFAULT for dictKey/dict remains `'open'` so existing dictKey collections are unaffected (alias-equivalence: existing puts still succeed).
- **altKey uniqueness** is enforced at materialization (declare/warm time), not per-put — the collision is a config error surfaced early (`ValidationError`).

- [ ] Step 1 (RED): `lookup-vocabulary.test.ts` — a closed `dict('status', { keys:['draft','sent'], vocabulary:'closed' })`: `put` with `'paid'` throws `UnknownLookupKeyError`; `put` with `'draft'` succeeds; the SAME dimension declared `'open'` accepts `'paid'`. A collection-backed `lookup('countries', { vocabulary:'closed' })` with `countries` empty → `put({country:'US'})` throws; after `countries.put('US', …)` → succeeds (async membership via the closure, the enforceRefsOnPut precedent). `lookup-altkeys.test.ts` — `lookup('countries', { key:'iso2', altKeys:['iso3','callPrefix'] })`: `put({country:'USA'})` stores `country:'US'` (ingest normalized); `put({country:'+1'})` also normalizes to `'US'`; a backing table where `iso3:'CHE'` and another row's `callPrefix:'CHE'` collide → materialization throws `ValidationError`. Assert `ViaWriteCtx` shape is unchanged (no cross-collection door — the closure carries membership, not a handle). RED.
- [ ] Step 2 (GREEN): implement `ingest`/`enforceWrite`, `materializeBackingTable`, the vault-built closure, `UnknownLookupKeyError`. Wire `membership` into `LookupViaConfig`. Run RED → GREEN. Run the FULL dict/i18n suites → GREEN unchanged (default open vocabulary preserves dictKey behavior; the alias parity fixtures still pass). `pnpm --filter @noy-db/hub typecheck`.
- [ ] Step 3: `pnpm check:architecture`; confirm the closure is vault-built (grep `shape/via-lookup/binding.ts` for `Collection`/`keyring`/`DEK` → none; membership is a plain function on cfg). Ceilings unchanged in guarded files (logic is in shape/registry). `pnpm --filter @noy-db/hub lint`. `grep accounting-firm`. Commit — `feat(hub): altKey ingest normalization + open/closed vocabulary write refusal (fixes #649, #650)`.

---

### Task 4: Reserved-tier sync (#647) — choke-point participation + reserved-prefix pull + wave reachability

**Files:**
- Modify: `shape/via-lookup/handle.ts` — `LookupHandle.put/delete/rename` additionally fire the optional `onDirty` + `onRecordMutated` hooks (origin `local-write`) threaded from `BuildLookupHandleOptions` (Task 1). The existing `emitter.emit('change', …)` shape is PRESERVED (dict-emitter.test.ts lock). Crypto stays on `reservedEnvelopes` (whole-DEK — no per-record CEK, so no id-threading applies to reserved decrypt; a matrix-backed dimension uses ordinary Collection reads where id IS already threaded).
- Modify: `kernel/vault.ts` — thread `onDirty` (the vault's `SyncEngine`-fed dirty callback, same one Collections get — `collection.ts:210`/`:646`) and `onRecordMutated` (a thin `graphDispatch.collect`-equivalent that opens the wave for the reserved collection) into `buildLookupHandle`. Maintain an explicit **reserved-lookup prefix registry** — the set of declared `_lookup_<dim>`/`_dict_<name>` collection names for dimensions with `backing:'reserved'`.
- Modify: `with-party/team/sync.ts` — `pull()` enumerates the declared reserved-lookup collections (via `remote.list(vault, collName)` + `remote.get(...)` per id — the store `list` does NOT skip `_`-prefixed names, unlike `loadAll`, `memory-store.ts:58-61` vs `:63-75`) and applies them through the SAME `applyRemote` path, INSIDE the existing `try` block BEFORE `persistMeta`/`flush`. This is the explicit prefix registry, NOT a blanket underscore-glob — other `_` namespaces keep their `loadAll`-skip semantics.
- Modify: `kernel/noydb.ts` — expose the reserved-lookup prefix registry to the `SyncEngine` next to the existing sync wiring (`noydb.ts:686` region).
- Test: `packages/hub/__tests__/via/lookup-reserved-sync.test.ts` (new, two-instance end-to-end).

**Interfaces — Produces:**

```ts
// with-party/team/sync.ts — the SyncEngine gains a reserved-lookup source
export interface ReservedLookupSource {
  /** Declared reserved-lookup collection names to enumerate on pull (the explicit registry). */
  collections(): readonly string[]
}
// SyncEngine constructor/ctor-seam gains `reservedLookup?: ReservedLookupSource`.
```

**Interfaces — Consumes:** `remote.list`/`remote.get`/`applyRemote` (`sync.ts`), `graphBatchController` begin/flush (`sync.ts:326`/`:454`), `ViaGraph.dependentsOf` (`via-graph.ts:284`), `runGraphDispatchWave` (`via-dispatch.ts:47`).

Design notes (per spec §2 + seam map Part 5 CRITICAL finding + watch items):
- **Ordering (explicit, load-bearing):** the reserved-prefix enumeration + apply happens INSIDE `pull()`'s `try` BEFORE line 452 (`persistMeta`) and BEFORE line 454 (`graphBatchController.flush()`). Because the wave flushes ONCE at pull end, vocabulary rows are applied FIRST and any dependents (records whose `present` labels or derived fields depend on a renamed/edited lookup row) recompute AFTER — never the reverse. Encode this as a test assertion (a vocabulary edit + a dependent recompute in one pull, asserting the dependent sees the NEW label).
- **Wave reachability:** because reserved writes now fire `onRecordMutated`, a reference-row update (`rename`/`put` on `_lookup_countries`) feeds `dependentsOf('_lookup_countries')` → `runGraphDispatchWave`. The dimension's cross-collection edge (Task 5) makes referencing collections dependents; a renamed label recomputes/invalidates their presentation per the graph. Local-write reserved edits keep inline dispatch (the `local-write` origin, `via-dispatch.ts:5-7`).
- **Emit-shape lock:** `dict-emitter.test.ts` (put/delete/rename/putAll emit `{vault, collection:'_dict_status', id, action}`) must stay GREEN — the `onDirty`/`onRecordMutated` calls are ADDED alongside the existing emit, not replacing it. If the test observes a NEW event it is additive coverage, not a flip.

- [ ] Step 1 (RED): `lookup-reserved-sync.test.ts` — two Noydb instances over a shared remote memory store. On A: declare `orders` with `status: dict('status')` + put a lookup row `status/paid = {en:'Paid'}` and an order `{status:'paid'}`. `A.sync()` (push). On B: `B.pull()` → assert B's `_dict_status`/`_lookup_status` row is present (was invisible pre-#647 because `loadAll` skips `_`; now the explicit prefix enumeration carries it) AND `B.orders.get('o1', {locale:'en'})` dresses `statusLabel === 'Paid'`. Then on A: `rename('paid','settled')` + sync; on B: `pull()` → assert the order's dressed label reflects the rename (vocabulary row applied BEFORE the dependent recompute — the ordering assertion). Also assert `dict-emitter.test.ts` shape is untouched (re-run it). RED (no reserved-prefix pull, no choke-point hooks).
- [ ] Step 2 (GREEN): implement the handle hooks, the reserved-lookup prefix registry, the sync-pull enumeration (ordered before flush), the noydb wiring. Run RED → GREEN. Run the FULL sync + dict + `via/sync-dispatch.test.ts` suites → GREEN unchanged (non-lookup collections' pull is byte-identical; the reserved enumeration is additive and gated on the registry being non-empty). `pnpm --filter @noy-db/hub typecheck`.
- [ ] Step 3: `pnpm check:architecture`; confirm `sync.ts` reaches the graph/wave via the existing `graphBatchController` seam only (no new spine→shape import). Ceilings: vault.ts gains the registry field + thread — confirm ≤ Task-1 ratcheted ceiling; if over, shrink-first or flag BLOCKED. `pnpm --filter @noy-db/hub lint`. `grep accounting-firm`. Commit — `fix(hub): reserved lookup tier participates in the choke point + syncs via an explicit reserved-prefix registry (fixes #647, #650)`.

---

### Task 5: Ref semantics (#648) — `'ref'` EdgeKind, restrict default, cascade/nullify, forget-fanout + taint composition

**Files:**
- Modify: `kernel/via-graph.ts` — add `'ref'` to `EdgeKind` (`via-graph.ts:15`); add a reverse-edge accessor bounded for delete/forget-time reference lookups (NOT a scan): reuse the existing `_out` reverse map (`via-graph.ts:77`) via `referencingEdgesOf(dimensionCollection)`.
- Modify: `shape/via-lookup/registry.ts` / `kernel/vault.ts` — a lookup declaration registers a cross-collection `registerDerived({collection: referencing, field}, [{collection: backing, field:'*'}], 'ref', 'record')` edge at `vault.collection()` time (the natural hook next to `refRegistry.register`, `vault.ts:920-922`). The graph already accepts cross-collection sources (`via-graph.ts:98-111`) — the declare-path is the work (seam map Part 6).
- Modify: `with-shape/links/vault-facade.ts` (`VaultLinks`) — extend `enforceRefsOnDelete` to consult the lookup dimension's referencing edges: `restrict` (default) throws `DictKeyInUseError` naming the referencing collection(s) + count (reusing `RefRegistry.inbound`-style reverse lookup, `refs.ts:259-263`, NOT a per-delete scan — bound the cost via the inbound index); `cascade` tombstones referencing records through ordinary origin-tagged deletes (fanout-visible); `nullify` clears the referencing field via ordinary puts. `nullify` is NEW (does not exist anywhere today — seam map Part 3).
- Modify: `shape/via-lookup/handle.ts` — `LookupHandle.delete(key, {mode})` strict branch calls the real reference check (the empty comment block at `dictionary.ts:522-530` becomes a real `DictKeyInUseError` throw — #648).
- Modify: `kernel/via-dispatch.ts` — `forgetDerivedFanout` gains a `'ref'` branch (`via-dispatch.ts:206-216` region): forgetting a referenced backing row under `restrict` is REFUSED before any shred; under `cascade`/`nullify` the fanout reports the propagation ADDITIVELY. Taint: a lookup INTO a collection with classified fields folds that collection's field postures into the derived presentation posture (edges carry real postures — the `'*'`-node collection-posture frame from #642 is NOT built here; lookup edges are field-level).
- Modify: `with-audit/forget/strategy.ts` — additive `ForgetResult` fields for lookup ref propagation (existing field byte-shape LOCKED, the phase-C precedent).
- Test: `packages/hub/__tests__/via/lookup-ref-semantics.test.ts` + `packages/hub/__tests__/via/lookup-forget-ref.test.ts` (both new).

**Interfaces — Produces:**

```ts
// kernel/via-graph.ts
export type EdgeKind = 'computed' | 'derivation' | 'rollup' | 'mv' | 'overlay' | 'ref'   // + 'ref'
/** Referencing edges pointing AT a backing dimension (delete/forget-time restrict/cascade/nullify). */
referencingEdgesOf(backing: string): ReadonlyArray<{ readonly referencing: FieldRef; readonly onDelete: OnDelete }>

// with-audit/forget/strategy.ts — APPEND to ForgetResult (existing fields byte-unchanged):
readonly lookupReferencesCascaded: number    // #648 — referencing records tombstoned (cascade)
readonly lookupReferencesNullified: number   // #648 — referencing fields cleared (nullify)
```

**Interfaces — Consumes:** `DictKeyInUseError` (`errors.ts:1389-1416` — `(dimension, key, usedBy, count)`), `RefRegistry.getInbound` (`refs.ts:259-263`), `enforceRefsOnDelete` (`vault-facade.ts:174+`), `forgetDerivedFanout`/`ForgetFanoutStats` (`via-dispatch.ts:176-227`), `foldPosture`/`effectivePosture` (`via-graph.ts:34`/`:209`).

Design notes (per spec §4 + decision 3 + seam map Part 6/surprise 12 + watch items):
- **restrict is the default** (decision 3). `DictKeyInUseError` is thrown for real (#648) — its constructor already carries `usedBy`+`count`. The retire-don't-delete lifecycle (rename) is the sanctioned path; today's dangling behavior remains ONLY for undeclared (non-lookup) refs.
- **Cost bound (watch item):** `restrict`/`cascade`/`nullify` need reverse-edge lookups at delete/forget. Use `RefRegistry.inbound` (the existing inbound index, O(1) per target) + the graph's `_out` reverse map — NEVER a per-delete collection scan. Counting referencing records reuses the `enforceRefsOnDelete` machinery, which is already inbound-driven.
- **forget × restrict is philosophically awkward** (seam map surprise 12: a GDPR erasure that throws because an invoice references the subject). The design decision (spec §4): forgetting a referenced backing row under `restrict` is refused BEFORE any shred (the reference must be retired first); `cascade`/`nullify` propagate additively. State this in the doc (Task 7).
- **Taint composition:** a lookup edge whose source names a classified FIELD contributes that field's posture; a `field:'*'` whole-collection source contributes `DEFAULT_POSTURE` (`via-graph.ts:174-183`) — so a matrix lookup into a plain `countries` collection taints nothing, while a lookup pointing at a classified field folds sealed/non-export. No `'*'`-node posture frame is built (out of scope, #642).
- **Pin-flip enumeration (this task):** NONE required. `refs.test.ts` is byte-unchanged (conflict resolution 2 — `ref()`'s `_`-guard stays). `dictionary.test.ts:155-164` (`delete removes an entry`) has NO referencing records in its fixture, so real `restrict` still succeeds — no flip. `DictKeyInUseError` had zero tests/throw sites (seam map surprise 3) — pure new coverage.

- [ ] Step 1 (RED): `lookup-ref-semantics.test.ts` — reserved `dict('status', { onDelete:'restrict' })` referenced by `orders.status='paid'`: `vault.dictionary('status').delete('paid')` throws `DictKeyInUseError` with `usedBy:'orders'`, `count:1`; after removing the order, `delete('paid')` succeeds. `onDelete:'cascade'` → deleting the row tombstones the referencing order (fanout-visible). `onDelete:'nullify'` → deleting the row sets `orders.status = null` via an ordinary put. A matrix `lookup('countries', {onDelete:'restrict'})` behaves identically against a first-class `countries` collection. Assert `refs.test.ts` + `dictionary.test.ts` unchanged. `lookup-forget-ref.test.ts` — (a) `forget()` of a `countries` row under `restrict` while an order references it is REFUSED before shred; (b) under `cascade`, the fanout reports `lookupReferencesCascaded === 1` and the order is tombstoned, subject fully shredded; (c) under `nullify`, `lookupReferencesNullified === 1`; (d) existing `ForgetResult` keys byte-unchanged (snapshot pre-existing keys); (e) taint — a `lookup` into a classified-field source seals the derived presentation (folded posture), a lookup into plain `countries` does not. RED.
- [ ] Step 2 (GREEN): add the `'ref'` EdgeKind + reverse accessor + declare-path edge registration, the `VaultLinks` restrict/cascade/nullify extension, the `LookupHandle.delete` real check, the `forgetDerivedFanout` `'ref'` branch, the `ForgetResult` fields. Run RED → GREEN. Run the FULL refs + forget + via graph/taint + dict suites → GREEN unchanged (additive fields default `0`; non-lookup forget byte-identical). `pnpm --filter @noy-db/hub typecheck`.
- [ ] Step 3: `pnpm check:architecture`; confirm `via-graph.ts` remains metadata-only (grep for values/keys → none). Ceilings: the edge registration is a thin vault.ts call — confirm ≤ Task-1 ratcheted ceiling; the enforcement lives in `VaultLinks`/`via-dispatch.ts` (unguarded). `pnpm --filter @noy-db/hub lint`. `grep accounting-firm`. Commit — `fix(hub): lookup ref semantics — restrict default (DictKeyInUseError), cascade/nullify, forget fanout + taint (fixes #648, #650)`.

---

### Task 6: The sync snapshot + locale seam + #626 retirement — `via-layering` allowlist ends EMPTY

**Files:**
- Create: `packages/hub/src/shape/via-lookup/snapshot.ts` — the sync materialized `key → row` map (the `active.ts` `_syncCache`/`snapshotEntries` pattern, seam map Part 1) + a sync locale-aware `presentForJoin(record, locale)` present-for-join function and a `compareForOrder` helper closing over the snapshot at the query locale.
- Modify: `shape/via-lookup/binding.ts` — `compareForOrder(field, a, b)` resolves via the snapshot+locale CLOSURE (signature UNCHANGED — `via.ts:128-129`); wire `snapshotFor` into `LookupViaConfig`.
- Modify: `kernel/query/join.ts` — DELETE the import `applyI18nLocale, type I18nTextDescriptor` (`join.ts:51-52`); replace the `applyI18nLocale(...)` call (`join.ts:379`) with a NEW optional sync hook on `JoinableSource`: `presentForJoin?: (record: unknown, locale: string) => unknown`, built by the Collection from its i18n + lookup bindings (the #626 reviewer-spec'd shape — seam map Part 2 item 4). The dict-join leg (`join.ts:294-317`) already resolves against the snapshot — unify it onto the same snapshot source.
- Modify: `kernel/collection.ts` — build `presentForJoin` on the `JoinableSource` it exposes (the sync, i18n-text-only + lookup-label entry point from the collection's own bindings). Threads through the existing `resolveSource`/`resolveDictSource` seam.
- Modify: `kernel/query/builder.ts` — `orderBy(field, {by:'label'})` label maps (`builder.ts:1371-1395`) source from the lookup snapshot for lookup fields (generalize `resolveDictSource`, seam map surprise 6) — the label-sort output stays byte-identical (parity lock).
- Modify: `scripts/check-architecture.mjs` — `VIA_SHAPE_ALLOWLIST` → `new Map([])`; DELETE the `join.ts → ['../../shape/via-i18n/core.js']` entry from `PRE_EXISTING_SPINE_SERVICE_IMPORTS` (`:1424-1426`).
- Test: `packages/hub/__tests__/via/lookup-join-snapshot.test.ts` (new) + `packages/hub/__tests__/via/via-layering-empty.test.ts` (new synthetic-fire proof).

**Interfaces — Produces:**

```ts
// kernel/query/join.ts — JoinableSource gains ONE optional sync hook (replaces i18nFields path)
readonly presentForJoin?: (record: unknown, locale: string) => unknown

// shape/via-lookup/snapshot.ts
export interface LookupSnapshot {
  row(key: string): Record<string, unknown> | undefined
  label(key: string, locale: string, fallback?: unknown): string | undefined
  compareKeys(a: string, b: string, locale: string): number
}
export function buildLookupSnapshot(dimension: string, rows: ReadonlyMap<string, Record<string, unknown>>, descriptor: LookupDescriptor): LookupSnapshot
```

**Interfaces — Consumes:** `JoinableSource` (`join.ts:122-149`), `applyI18nLocale`'s sync contract (folded into `presentForJoin` on the i18n side — the i18n binding gains a sync `presentForJoin` half; the shape import moves BEHIND the binding so `join.ts` imports nothing from shape/), `compareForOrder` (`via.ts:128-129`), `resolveDictSource` (`vault.ts:1777-1816`, now snapshot-sourced).

Design notes (per spec §5 + seam map Part 2 + conflict resolution 4):
- **One combined seam** serves join-dressing, dimension sort, and membership: the sync snapshot (materialized key→row) + a locale-aware present function. `compareForOrder`'s signature is UNCHANGED — it gets the snapshot via the binding closure (conflict resolution 4). Membership (Task 3, reserved/static tiers) reads the same snapshot synchronously.
- **#626 retirement is mechanically checkable:** deleting `join.ts:51-52` + emptying both guard entries. The i18n text-locale-for-join responsibility moves onto the binding's sync `presentForJoin` (the reviewer-preferred fix, Part 2 item 4) — join.ts calls `source.presentForJoin?.(right, effLocale)` and imports zero shape specifiers. This lazily tree-shakes the ~100-LOC i18n resolver out of the core query path (Part 2 bonus).
- **Parity lock:** `query-join-i18n.test.ts` (the #626 behavior lock) and `query-dictkey-label-sort.test.ts` must pass UNCHANGED — the join dressing + label-sort OUTPUT is byte-identical; only the plumbing changed. This is a parity flip of mechanism, not behavior (NO test edits beyond additive).

- [ ] Step 1 (RED): `lookup-join-snapshot.test.ts` — a `.join()` of an order onto a reserved `status` dimension at `{locale:'th'}` dresses the joined record's label via `presentForJoin` (identical output to today's dict-join leg); `orderBy('status', {by:'label'})` sorts by the localized label from the snapshot (byte-identical to `query-dictkey-label-sort.test.ts`'s expected order). `via-layering-empty.test.ts` — a meta-test that reads `scripts/check-architecture.mjs`'s `VIA_SHAPE_ALLOWLIST` is empty AND that a synthetically-injected `kernel/query/join.ts` importing `../../shape/via-i18n/core.js` makes `checkViaLayering` FAIL (the phase-B deletion recipe — write a temp kernel file importing shape/, run the checker programmatically, assert non-zero, clean up). RED (join still imports shape; allowlist non-empty).
- [ ] Step 2 (GREEN): implement `snapshot.ts`, the binding `compareForOrder` closure + `snapshotFor`, the `presentForJoin` hook on `JoinableSource`, the collection-side builder, the builder label-map generalization, delete `join.ts:51-52`, empty both guard entries. Run RED → GREEN. Run the FULL join suites (`query-join*.test.ts`, `query-join-i18n.test.ts`) + `query-dictkey*.test.ts` + label-sort → GREEN UNCHANGED. `pnpm --filter @noy-db/hub typecheck`.
- [ ] Step 3: `node scripts/check-architecture.mjs` → OK with `VIA_SHAPE_ALLOWLIST` EMPTY and no join.ts grandfather; confirm `grep -rn "shape/via-i18n" packages/hub/src/kernel/query/join.ts` returns nothing. Ceilings: collection.ts gains the `presentForJoin` builder — confirm ≤ 4473 (shrink-first from a dense decl if needed, or route the builder into a helper file). `pnpm --filter @noy-db/hub build && bundle-check` (the i18n resolver tree-shakes out of the query floor). `pnpm --filter @noy-db/hub lint`. `grep accounting-firm`. Commit — `refactor(hub): sync lookup snapshot + locale seam; join.ts drops the shape import — via-layering allowlist now EMPTY (retires #626, #650)`.

---

### Task 7: `describe()`/fragments + countries-matrix showcase + docs + changeset + final guards/ceilings

**Files:**
- Modify: `with-shape/introspection/describe.ts` — WIRE `describe()` to consume per-binding `describeFragment`s (the mechanism has zero consumers today — seam map Part 7 / surprise 5; `describe()` is config-direct at `collection.ts:973-985`). Emit a normalized `lookup` block on `DescribedField`: key set (closed vocabularies), dimensions, presentation metadata, backing kind, vocabulary. Keep the existing `dict`/`ref` blocks byte-stable for the alias (describe parity).
- Modify: `kernel/collection.ts` — the `describe()` assembly reads `via` binding fragments (first-ever consumer of `ViaBinding.describeFragment`).
- Create: `packages/hub/__tests__/via/countries-matrix.test.ts` — the canonical countries matrix end-to-end (ISO2 canonical, ISO3/callPrefix altKeys, localized names, sparse dimensions, populate-only-used). This is the shipped-tests-only source of truth for the doc.
- Create/modify: `docs/subsystems/via-lookup.md` — the new subsystem page (SHIPPED-TESTS-ONLY: document only what the green tests prove). Update `docs/subsystems/via-i18n.md` to point dict/staticDict at the alias story. Update `SERVICES.md` if the service surface changed.
- Create: `.changeset/<name>.md` — `@noy-db/hub: minor`.
- Modify: `scripts/check-architecture.mjs` — final ceiling re-ratchet DOWN to post-phase actuals (comment `#650`); NO bumps.
- File (wrap-up): a follow-up issue for the `@noy-db/ui` select/autocomplete widget (sibling repo — out of scope, spec §6).

**Interfaces — Consumes:** `ViaBinding.describeFragment` (`via.ts:136`), `DescribedField` (`describe.ts:50`), `deriveWidget` (`describe.ts:250` — `'select'` when a lookup block exists).

Design notes (per spec §6 + §8):
- `describeFragment` wiring is IN scope hub-side; the `@noy-db/ui` widget is the sibling repo's follow-up (issue filed at wrap-up). The realistic hub deliverable is a normalized `lookup` block (dimension, backing kind, vocabulary, values-or-source) that `schemaFromDescribe`/`fieldInput` can grow into (seam map Part 7).
- The **countries matrix** is the canonical example in EVERY doc/showcase this phase touches (standing directive, spec §6).
- Changeset body enumerates: the #647/#648/#649 fixes; the `restrict` default (BEHAVIOR CHANGE — deleting/forgetting a referenced lookup row is now REFUSED by default; deliberate, pre-1.0 `@next`); the alias story (dictKey/staticDict → lookup binding, byte-equivalent); the #626 retirement (join.ts shape import gone); `via(lookup(...))`/`enum()`/`dict()` additive API. DO NOT publish.

- [ ] Step 1 (RED): `countries-matrix.test.ts` — `lookup('countries', { key:'iso2', altKeys:['iso3','callPrefix'], present:{label:'name', by:'locale'}, sortBy:'name', backing:'collection', vocabulary:'closed' })`. Assert: ingest normalizes `'USA'`/`'+1'` → `'US'`; closed vocabulary refuses `'ZZ'`; localized `name` dresses per locale; `orderBy(..., {by:'label'})` sorts localized names via the snapshot; `describe()` emits a `lookup` block with the key set + dimensions + `widget:'select'`; only used dimensions populate (sparse). A describe-fragment test asserting `describe()` now reflects a binding's `describeFragment`. RED.
- [ ] Step 2 (GREEN): implement the `describe()` fragment consumption + `lookup` block, make the countries matrix green. Run the FULL describe suites (`describe.test.ts`, `describe-contract.test.ts`, `describe-constraints.test.ts`, `classified/describe-emission.test.ts`) → GREEN unchanged (existing `dict`/`ref` blocks byte-stable). `pnpm --filter @noy-db/hub typecheck`.
- [ ] Step 3: Docs from SHIPPED TESTS ONLY (the phase-A/B/C binding lesson) — `docs/subsystems/via-lookup.md` covers the three tiers, altKeys, open/closed vocabulary, backing choice, restrict/cascade/nullify, reserved-tier sync, the snapshot+locale seam. NO speculative API.
- [ ] Step 4: Full gauntlet — `pnpm --filter @noy-db/hub test` (whole hub suite green), `pnpm --filter @noy-db/hub typecheck` (×3 tsconfigs), `pnpm --filter @noy-db/hub lint`, `node scripts/check-architecture.mjs` (via-layering EMPTY + fires on synthetic; via-enclave EMPTY + fires on synthetic `shape/via-lookup/** → kernel/enclave`; ceilings re-ratcheted DOWN, none bumped), `pnpm --filter @noy-db/hub build && bundle-check` (lookup binding out of the floor for lookup-free collections; new scenario if warranted), `pnpm knip`, `pnpm validate:features` (if `features.yaml` gained a lookup capability).
- [ ] Step 5: Changeset `.changeset/<name>.md` (`@noy-db/hub: minor`) with the enumerated body above. `grep -rn accounting-firm` the WHOLE diff. File the `@noy-db/ui` widget follow-up issue. Commit — `docs(hub): via phase D — via-lookup tiers/altKeys/vocabulary/ref-semantics + countries matrix + changeset (#650)`.

---

## Final steps (execution skill handles)

Full hub suite green; whole-branch review on the most capable model (focus: alias-equivalence byte-parity across every tier — the phase's biggest regression surface; the #647 reserved-prefix-pull-BEFORE-wave-flush ordering; the `restrict` reverse-edge cost bound; the membership closure's zero-knowledge boundary — grep the new `shape/via-lookup/**` for keyring/DEK/CEK/Collection access and confirm none; verify `VIA_SHAPE_ALLOWLIST` + `VIA_ENCLAVE_ALLOWLIST` both EMPTY and both fire on synthetics; confirm every new `decryptRecord`/reserved-decrypt call threads the record id where a per-record CEK path applies). PR against `main` (do NOT merge — human gate). Fixes #647/#648/#649; retires #626; closes milestone #28's phase-D scope (#650).
