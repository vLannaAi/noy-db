# Milestone #32 — Via follow-ups 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four open milestone-#32 issues — #670 (LookupHandle.rename() self-refusal), #672 (money index-key canonicalization), #669 (money dresses a virtual computed field's output as MAJOR UNITS — user-ratified design), #671 (five late-attach reconcile residuals).

**Architecture:** All fixes ride existing seams: the `ViaBinding`/`ViaPipeline` port (`kernel/via/`), the vault reconcile path (`kernel/via/reconcile.ts`), and the `via/money` + `via/lookup` families. Ground truth for every call site, line number, and code excerpt is `.superpowers/sdd/m32-seam-map.md` — each task names the section that is its map. Where the plan and the live tree disagree, the tree wins; where the plan and the seam map disagree, re-read the tree and flag it.

**Tech Stack:** TypeScript ESM, vitest, pnpm + turbo. Work in `packages/hub`.

## Global Constraints

- **Ceilings, zero slack (check-architecture Check 6, metric = `split('\n').length`):** `kernel/collection.ts` ≤ 4472, `kernel/vault.ts` ≤ 3939, `kernel/noydb.ts` ≤ 2385. All three sit EXACTLY at ceiling. Every line you add to one of these files must be offset by removing a line in the SAME file (genuine compression — collapse a wrappable statement, tighten a multi-line comment — never delete tests, blank-line-squash inside unrelated code, or harm clarity). If you cannot find an offset, report BLOCKED — do not raise the ceiling.
- **Check 14 (via-layering), EMPTY allowlist:** no file under `src/kernel/**` may statically import from `src/via/**`. Kernel-side needs go through `kernel/via/index.ts` hook contracts or the existing strategy/port channels. **Check 15 (via-enclave-isolation), EMPTY allowlist:** no file under `src/via/**` may import `kernel/enclave/*`.
- **TDD:** failing test first, then the fix, per task. Tests live in `packages/hub/__tests__/`.
- **Behavior locks:** the #665 corruption fence — a composed `via(computed(fn,{mode:'virtual'}), money(...))` field must NEVER present as the scaled-decode string `'0.21'` for output `21`; money's stored-field decode must keep running BEFORE the computed segment. The full existing suite passes unchanged except where a task EXPLICITLY lists a pinned test it deliberately updates.
- **Never** add Claude attribution to commits. **Never** reference the private pilot client by name. Changesets are authored LOCALLY (`.changeset/*.md`, gitignored by repo convention) — never committed.
- Run from repo root: `pnpm --filter @noy-db/hub test` (full hub suite), or single file `pnpm vitest run packages/hub/__tests__/<file>`. Before the branch finishes: `pnpm check:architecture`, `pnpm --filter @noy-db/hub typecheck`, lint.
- Commit after each green task: `git add <files> && git commit -m "<type>(hub): <subject> (#<issue>)"`.

---

### Task 1: #670 — `LookupHandle.rename()` write-through cache ordering

**Seam map:** §A of `.superpowers/sdd/m32-seam-map.md`.

**Files:**
- Modify: `packages/hub/src/via/lookup/handle.ts` (rename(), lines ~412-499)
- Test: `packages/hub/__tests__/via/lookup-closed-rename.test.ts` (new)
- Touch-up: `packages/hub/__tests__/via/reconcile-lookup.test.ts` (workaround comment, lines 108-113)

**Interfaces:** none new — pure internal reorder inside `rename()`.

- [ ] **Step 1: Write the failing test** — new file `__tests__/via/lookup-closed-rename.test.ts`. Recipe: vault with a dict-backed dimension; a collection declaring a `vocabulary:'closed'` reserved-tier lookup field on that dimension (see `reconcile-lookup.test.ts` for the wiring idiom, but with `vocabulary:'closed'` — the exact shape that file's comment says it avoids); seed the dictionary with key `'paid'`; put a record referencing `'paid'`; then `await handle.rename('paid', 'settled')`. Assert: (a) rename resolves (no `UnknownLookupKeyError`); (b) the referencing record now reads `'settled'`; (c) the old key is gone from the dictionary and the new key present. Add a second `it` pinning mid-rename semantics: during step 3 both old and new key are members (assert post-conditions only — the pin is the doc comment written in Step 3).
- [ ] **Step 2: Run it — must fail** with `UnknownLookupKeyError` thrown from the referencing-record rewrite.
- [ ] **Step 3: Fix** — in `rename()`, move `this._syncCache.set(newKey, newEntry)` from its current position (line ~453, after the old-key delete) to immediately after the step-2 adapter write of the new key (after line ~434), BEFORE `findAndUpdateReferences`. Leave `this._syncCache.delete(oldKey)` where it is (post old-key removal) — mid-rename BOTH keys are members, which is the correct transition semantics. Add a short comment stating exactly that: new key becomes a member before referencing records are rewritten (else closed-vocabulary `enforceWrite` self-refuses, #670); old key stays a member until its removal completes.
- [ ] **Step 4: Update the workaround comment** in `reconcile-lookup.test.ts:108-113` — it documents the pre-fix ordering; reword to say the ordering was fixed in #670 and open vocabulary is kept there only to isolate the late-attach registry concern.
- [ ] **Step 5: Run** the new test + `pnpm vitest run packages/hub/__tests__/dictionary.test.ts packages/hub/__tests__/dict-emitter.test.ts packages/hub/__tests__/via/lookup-reserved-sync.test.ts packages/hub/__tests__/via/lookup-extraction-parity.test.ts packages/hub/__tests__/via/reconcile-lookup.test.ts` — all green.
- [ ] **Step 6: Commit** — `fix(hub): rename() publishes the new key to the sync cache before rewriting references (#670)`.

---

### Task 2: #672 — money-aware index-key canonicalization

**Seam map:** §B. Fix shape (a): a new generic `ViaBinding` hook folded by `ViaPipeline`, mirroring `indexProbe` — never a `with-lookup → via/money` import, never a kernel → `src/via/**` import.

**Files:**
- Modify: `packages/hub/src/kernel/via/index.ts` (ViaBinding: new optional hook)
- Modify: `packages/hub/src/kernel/via/pipeline.ts` (fold, mirroring `indexProbe` at lines 194-197)
- Modify: `packages/hub/src/via/money/binding.ts` + `packages/hub/src/via/money/normalize.ts` (implementation via `moneyScaledValue`)
- Modify: `packages/hub/src/with-lookup/indexing/collection-facade.ts` (IndexingContext: new optional member) and `packages/hub/src/with-lookup/indexing/eager-indexes.ts` (bucket through the canonicalizer)
- Modify: `packages/hub/src/kernel/collection.ts` `indexingContext()` (~4454-4470) — ONE line, ceiling-offset required
- Test: `packages/hub/__tests__/via/money-index-canonical.test.ts` (new)

**Interfaces:**
- Produces on `ViaBinding`: `canonicalizeIndexKey?: (field: string, rawValue: unknown) => string | undefined` — sync, pure; `undefined` = "not mine / can't canonicalize, bucket raw".
- Produces on `ViaPipeline`: `canonicalizeIndexKey(field: string, rawValue: unknown): string | undefined` — first binding returning non-undefined wins (identical dispatch discipline to `indexProbe`).
- Produces on `IndexingContext<T>`: `readonly canonicalizeIndexKey?: (field: string, value: unknown) => string | undefined`.

- [ ] **Step 1: Write the failing test** — `__tests__/via/money-index-canonical.test.ts`, three blocks:
  1. **Mixed-era fixture:** open a collection WITHOUT money, `put` a record whose `amount` is the raw string `'0100'` (legacy non-canonical scaled form). Re-open the same collection name declaring `money({currency:'EUR', scale:2, mode:'fixed'})` on `amount` + an eager index on `amount`; `put` a second record through the money write path landing at scaled `'100'` (i.e. write `1` major unit). Query `where('amount','==', 1)` (the fast path — follow the existing spy technique from the #625 tests, grep `moneyIndexProbe` under `__tests__/` for the spy that proves the index path was taken, not the scan). Assert BOTH records return.
  2. **Rebuild-on-hydrate canonicalizes:** close/reopen the vault so eager indexes rebuild from cache; repeat the query; both records still return via the fast path.
  3. **Scan parity property:** for a small matrix of stored shapes (`'100'`, `'0100'`, `' 100'`-class junk, `100` number, `'abc'`, `null`), assert fast-path results ≡ forced-scan results for `==` and `in` clauses (non-parseable shapes are consistently no-match in both).
- [ ] **Step 2: Run — block 1 must fail** (fast path returns only the canonical record).
- [ ] **Step 3: Implement the hook chain.** (a) `kernel/via/index.ts`: add `canonicalizeIndexKey?` to `ViaBinding` with a doc comment stating the contract (bucket key for eager indexes; must agree with what the binding's own scan/probe treats as equal). (b) `kernel/via/pipeline.ts`: fold it exactly like `indexProbe` (194-197): iterate `bindings`, return the first non-undefined. (c) `via/money/normalize.ts`: export `canonicalizeMoneyIndexKey(field, rawValue, moneyFields): string | undefined` — return `undefined` unless `field` is a declared FIXED-mode money field; then `moneyScaledValue(rawValue, desc)?.toString() ?? undefined` (unparseable → `undefined` → raw bucket, which matches the scan's no-match — parity holds). (d) `via/money/binding.ts`: wire `canonicalizeIndexKey: (f, v) => canonicalizeMoneyIndexKey(f, v, moneyFields)`.
- [ ] **Step 4: Thread into indexing.** `collection-facade.ts`: add the optional member to `IndexingContext`. `collection.ts` `indexingContext()`: add `...(this.via ? { canonicalizeIndexKey: (f: string, v: unknown) => this.via!.canonicalizeIndexKey(f, v) } : {}),` as ONE line — and offset it (find one genuinely compressible line in `collection.ts`; state which in the report). `eager-indexes.ts`: `addToIndex`/`removeFromIndex` (and any other `stringifyKey(value)` bucket site used by build/upsert/delete) consult `ctx.canonicalizeIndexKey?.(idx.field, value)` first; if it returns a string, bucket under it, else `stringifyKey(value)` as today. The PROBE side (`lookupEqual`/`lookupIn` keys arriving from `moneyIndexProbe`) is already canonical — do NOT double-canonicalize there for money; but check whether generic probes for NON-money fields still match (canonicalizer returns `undefined` for them — untouched).
- [ ] **Step 5: Run** the new test file + the existing #625 money-index tests (grep `indexProbe`/`money-index` under `__tests__/` and run those files) + `pnpm vitest run packages/hub/__tests__/via/pipeline.test.ts packages/hub/__tests__/via/pipeline-b.test.ts`. All green.
- [ ] **Step 6: Docs touch:** `via/money/where.ts` doc comment (lines 136-171) says "filed as a follow-up, not fixed here" — update to state the canonicalization now exists (#672) and where. Same for the `candidateRecords` probe-site comment (`kernel/query/builder.ts` ~1110) and `docs/subsystems/via-money.md` Indexing section's mixed-era caveat (now closed — keep the paragraph, flip it to describe the guarantee).
- [ ] **Step 7: Ceiling check** — `pnpm check:architecture` green.
- [ ] **Step 8: Commit** — `fix(hub): money-aware eager-index key canonicalization closes the mixed-era fast-path gap (#672)`.

---

### Task 3: #669 — money dresses a virtual computed field's output as MAJOR UNITS

**Seam map:** §C. **Ratified design:** the computed fn's return is MAJOR UNITS. Money quantizes it to the currency scale (descriptor rounding) and presents it exactly like a stored money field: field → decimal string (`21` → `'21.00'`), `<field>Formatted` when a real locale is set, `<field>Number`. Never the scaled-int decode (`21` must never read as `'0.21'`). Unparseable/absent output → left raw, no throw at read time.

**Files:**
- Modify: `packages/hub/src/kernel/via/index.ts` (ViaBinding: `presentLate?` hook)
- Modify: `packages/hub/src/kernel/via/pipeline.ts` (present fold gains a presentLate slot AFTER the computed segment, BEFORE the rest segment)
- Modify: `packages/hub/src/kernel/collection-config.ts` (`compileViaBindings`: compute `virtualFields` BEFORE building money's binding; pass the money∩virtual field-name set into the money factory)
- Modify: `packages/hub/src/via/money/binding.ts` + `normalize.ts` (presentVirtualMoney)
- Modify: `packages/hub/src/kernel/collection.ts` `_applyMoneyFields` (late-attach parity — the intersection with `this.computed`'s virtual entries; coordinate with Task 4 which edits the same method)
- Test: `packages/hub/__tests__/computed/virtual.test.ts` (deliberate pinned-test updates, see Step 1) + new assertions

**Interfaces:**
- Produces on `ViaBinding`: `presentLate?: (record: Record<string, unknown>, ctx: ViaReadCtx) => Promise<Record<string, unknown>> | Record<string, unknown>` — runs after ALL `present()` hooks of the money+computed segments, before the rest segment (so taint/redaction still sees dressed values).
- Money factory signature grows an options bag: `viaBinder('money')(moneyFields)` → the compiled config carries `virtualMoneyFields?: ReadonlySet<string>` (exact plumbing shape: match how the money factory config is built today — keep the sugar/`via()` equivalence intact).

- [ ] **Step 1: Update the pinned tests FIRST (they are the spec).** In `__tests__/computed/virtual.test.ts`:
  - The KNOWN LIMITATION test (lines ~136-173) becomes the feature test: `read?.doubledPrice` is `'21.00'` (decimal string, major-units quantized), `doubledPriceFormatted` defined when a locale is set, `FieldNotQueryableError` pin UNCHANGED (virtual fields stay unqueryable).
  - The #665 regression pin (lines ~175-202): KEEP `expect(read?.doubledPrice).not.toBe('0.21')` — the corruption fence — and update the companions to `toBe('21.00')` / `typeof === 'string'`, with a comment that the fence is the `not.toBe('0.21')` line and the field is now major-units-dressed (#669).
  - The materialized control (lines ~204-234) stays byte-identical.
  - Add: fractional output `21.005` with declared rounding → `'21.01'`-class quantization; fractional output with NO rounding declared and excess precision → value left RAW (no throw, no dressing) — pin both.
- [ ] **Step 2: Run — the updated assertions must fail** (dressing doesn't exist yet).
- [ ] **Step 3: Pipeline slot.** In `pipeline.ts`: keep the three-way `_presentOrder` partition exactly as is (money's stored decode MUST stay ahead of computed — the #665 invariant); split the fold so `present()` runs money+computed segments, then every binding's `presentLate`, then the rest segment. Update the `_presentOrder` doc comment (lines 30-79) — its "value-shape decision left unresolved" paragraph (74-78) now resolves to #669 major-units via `presentLate`.
- [ ] **Step 4: Config + binding.** `collection-config.ts`: hoist the `virtualFields` computation (lines ~669-677) ABOVE the money push (line ~613); build `virtualMoney = new Set(Object.keys(moneyFields ?? {}).filter(f => virtualFields.has(f)))`; pass it into the money binding config. `via/money/binding.ts`: when `virtualMoney` is non-empty, expose `presentLate` calling a new `presentVirtualMoneyFields(record, moneyFields, virtualMoney, locale)` in `normalize.ts`: for each intersection field with a present, non-null value — `parseToScaledInt(value, desc.scale, desc.rounding)`; on `!ok` leave raw; on ok emit exactly what `decodeValue` emits for a stored field (decimal string via `formatScaledInt`, `Formatted` via `formatCurrency` when locale is real, `Number`). Money's ordinary `present()` must SKIP the intersection fields entirely (they're absent pre-computed anyway — keep the skip explicit with a comment).
- [ ] **Step 5: Late-attach parity.** `_applyMoneyFields` (collection.ts:1282-1286) must produce the same intersection when money late-attaches onto a collection that already has virtual computed fields: compute the set from `this.computed` (virtual-mode entries) via a helper that lives OUTSIDE collection.ts (e.g. exported from `kernel/collection-config.ts`), one call line; offset any net line growth in collection.ts. Add a parity test: fresh-composed vs money-late-attached collections dress a virtual field identically (follow the `#664 late-attach parity` test idiom — grep `late-attach parity` under `__tests__/`).
- [ ] **Step 6: Run** `pnpm vitest run packages/hub/__tests__/computed/virtual.test.ts packages/hub/__tests__/via/pipeline.test.ts packages/hub/__tests__/via/pipeline-b.test.ts packages/hub/__tests__/via/compose.test.ts packages/hub/__tests__/via/compose-cross-feature.test.ts` then the full money + formula suites (`pnpm vitest run packages/hub/__tests__/via -t money` at minimum; if any pipeline-partition pin elsewhere fails, update it DELIBERATELY and list it in the report). All green.
- [ ] **Step 7: Commit** — `feat(hub): money dresses a virtual computed field's output as major units (#669)`.

---

### Task 4: #671 items 4+5 — money-only late-attach keeps the taint overlay; ref-edge cycle filter

**Seam map:** §D.4 and §D.5. NOTE: Task 3 already edited `_applyMoneyFields` — read it fresh.

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` `_applyMoneyFields` (~1282) + `_applyClassifiedFields` (~1362): thread `this.via?.taint` through both `ViaPipeline.build(...)` calls (same-line edits, no net line change)
- Modify: `packages/hub/src/kernel/via/reconcile.ts` doc comment (~243-248) — the asymmetry it documents is now gone; rewrite to state all rebuild paths thread taint
- Modify: `packages/hub/src/kernel/via/graph.ts` `assertAcyclic`/`neighboursOf` (~209-257): filter `kind === 'ref'` edges
- Test: `packages/hub/__tests__/via/taint.test.ts` (or a new `reconcile-taint.test.ts`) + `packages/hub/__tests__/via/graph.test.ts`

**Interfaces:** none new.

- [ ] **Step 1: Failing test A (taint drop)** — the confirmed probe recipe: fresh collection with classified+computed (taint overlay materializes) → SECOND `vault.collection()` call for the same name adding ONLY `moneyFields` → assert `coll._via.taint` is still defined and `postureFor`/`redactForExport` still reflect the derived-taint postures. Run: fails (`taint === undefined`).
- [ ] **Step 2: Fix** — `_applyMoneyFields`: `ViaPipeline.build([...], this.via?.taint)`; same for `_applyClassifiedFields` (latent, masked by the reconcile-gate re-run — fix for code-level consistency). Rewrite the `reconcile.ts:243-248` comment. Add a regression assertion that the classified-only late-attach path (already green via the compensating `applyTaintOverlay` re-run at `reconcile.ts:437-440`) STAYS green.
- [ ] **Step 3: Failing test B (ref filter)** — in `graph.test.ts`: register two collections' mutual `kind:'ref'` edges via `registerDerived(..., 'ref', ...)` (mirror what `registerLookupRefEdges` does), then call `assertAcyclic()` → must NOT throw. Today it throws `DerivationCycleError` — that's the failing state. Also assert a genuine derived (non-ref) cycle STILL throws, and a mixed cycle (derived edges + one ref edge breaking the loop) does not false-positive.
- [ ] **Step 4: Fix** — in `neighboursOf`, filter candidates whose consuming edge kind is `'ref'`: apply `(list ?? []).filter(t => this._in.get(nodeId(t))?.kind !== 'ref')` to both the `own` and `wildcard` slices (see the seam map's excerpt — `_out` stores bare FieldRefs; kind lives on `_in`). Comment: mutual FKs are legal; ref edges exist for cascade/rename machinery, not derivation ordering (#671 item 5).
- [ ] **Step 5: Run** both test files + `pnpm vitest run packages/hub/__tests__/via/graph-edges.test.ts packages/hub/__tests__/via/reconcile-guard.test.ts` — green. Ceilings: net-zero on collection.ts (same-line edits) — verify with `pnpm check:architecture`.
- [ ] **Step 6: Commit** — `fix(hub): late-attach money/classified rebuilds thread the taint overlay; assertAcyclic ignores ref edges (#671)`.

---

### Task 5: #671 items 1-3 — late-attach refreshes the collection's read-side state

**Seam map:** §D.1-D.3. This is the ceiling-constrained task: all three residuals are construction-frozen `Collection` state that reconcile must now be able to refresh. Consolidate into ONE writer seam, not three.

**Files:**
- Modify: `packages/hub/src/kernel/collection.ts` — drop `readonly` from `getDictionary`/`presentForJoin` (and from `i18nFields`/`dictKeyFields`/`lookupFields` if marked); ONE new writer method `_reconcileReadState(patch)` next to `_setVia` (~4425); every net line added must be offset in-file
- Modify: `packages/hub/src/kernel/via/reconcile.ts` — the i18n/dictKey/lookup late-attach paths call the writer with merged descriptor maps + a rebuilt `presentForJoin` + `getDictionary`
- Check: how `buildPresentForJoin` reaches kernel code today — `collection-config.ts:1044` receives it via the SAME channel that hands `opts.snapshotFor` in (strategy/port injection). Reconcile must obtain it through that SAME channel (it already builds the five lookup closures incl. `snapshotFor` — trace where those come from and ride along). NO new kernel → `src/via/**` import (Check 14).
- Test: `packages/hub/__tests__/via/reconcile-read-state.test.ts` (new)
- Guard: if a surface golden (kernel-api prototype golden / `vault-private-surface.test-d.ts`) pins `Collection`'s public prototype, the new `_reconcileReadState` writer must be added there DELIBERATELY (like `_setVia` was) — list it in the report.

**Interfaces:**
- Produces on `Collection`: `_reconcileReadState(patch: { dictKeyFields?; i18nFields?; lookupFields?; getDictionary?; presentForJoin? }): void` — merge semantics for the three descriptor maps (construction-time entries win on collision — reconcile already refuses colliding fields upstream), assignment for the two closures. Underscore-prefixed writer seam, same discipline as `_setVia` (`collection.ts:4425`).

- [ ] **Step 1: Write the failing tests** — `reconcile-read-state.test.ts`, one `it` per residual, each using the late-attach recipe (open collection bare → second `vault.collection()` call attaches the family):
  1. **getDictionary:** late-attach a dict-backed `dictKey` field → `describeAsync({resolveDictLabels:true})` resolves the field's labels (today: silently absent).
  2. **describe() legacy lists:** late-attach a lookup field → `describe()`'s top-level field list/widget derivation includes it (compare against the same declaration made fresh — the outputs must be deep-equal; today the late one is missing from the legacy lists while its `.lookup` fragment is present).
  3. **presentForJoin:** collection A (join target) opened bare, late-attach an i18n or `present`-dressed lookup field, then a join query from collection B dresses `<field>Label`/i18n text through the join path exactly as a fresh declaration would (today: `presentForJoin` is `undefined` forever).
- [ ] **Step 2: Run — all three fail.**
- [ ] **Step 3: Implement.** collection.ts: remove `readonly` modifiers; add `_reconcileReadState` (target ≤ 12 lines including doc comment; offset every net-added line in-file — report the exact offsets). reconcile.ts: at the end of each family's late-attach block, assemble the patch — merged maps (`{...late, ...(coll's existing ?? {})}` per the collision rule), `getDictionary` (the same closure shape vault passes at construction — reconcile has the vault context that builds the five lookup closures; reuse it), and `presentForJoin` rebuilt over the UNION of construction-time + late-attached i18n/lookup fields with the same `snapshotFor` closure it already constructs. Call `coll._reconcileReadState(patch)` once per reconcile pass (not once per family) if that keeps reconcile.ts simpler.
- [ ] **Step 4: Run** the new file + `pnpm vitest run packages/hub/__tests__/via/reconcile-lookup.test.ts packages/hub/__tests__/via/reconcile-i18n-dictkey.test.ts packages/hub/__tests__/via/reconcile-guard.test.ts packages/hub/__tests__/via/binding-order-reconcile.test.ts` + the describe/introspection suites (`pnpm vitest run packages/hub/__tests__ -t describe` as a sweep). All green. `pnpm check:architecture` green (ceilings + Check 14).
- [ ] **Step 5: Commit** — `fix(hub): late-attach reconcile refreshes describe lists, dict label resolution, and join dressing (#671)`.

**Housekeeping rider disposition (record in report, no code):** the four "must move together (#664)" comment pairs stay as-is — a shared builder would churn zero-slack `vault.ts` for a convention-hardening gain; deferred deliberately, noted in the PR body.

---

### Task 6: Docs, changeset, full gauntlet

**Files:**
- Modify: `docs/subsystems/via-money.md` (Indexing section — mixed-era caveat closed by #672; major-units virtual dressing #669), `docs/subsystems/via-computed.md` (Composition + Present-order sections — #669 resolved), `docs/subsystems/via-lookup.md` (Late-attach section — residual list updated for #671 items fixed; rename ordering note for #670; ref-edge filter note)
- Create (LOCAL ONLY, not committed): `.changeset/m32-via-followups.md` — `@noy-db/hub: minor` (adds the major-units dressing behavior + index canonicalization; #670/#671 ride along), body naming all four issues
- Check: `features.yaml` — if via-money/via-computed composition or lookup rename semantics have catalog entries whose prose now lies, update and run `pnpm validate:features`

- [ ] **Step 1:** Sweep the four subsystem docs — every KNOWN LIMITATION paragraph the four fixes invalidate gets flipped to describe the new guarantee (grep the docs for `#669`, `#670`, `#671`, `#672`, `KNOWN LIMITATION`, `mixed-era`).
- [ ] **Step 2:** Author the changeset locally. Do NOT `git add` it.
- [ ] **Step 3:** Full gauntlet from repo root: `pnpm --filter @noy-db/hub test`, `pnpm --filter @noy-db/hub typecheck`, hub lint script, `pnpm check:architecture`, `pnpm validate:features` (if features.yaml touched), `pnpm --filter @noy-db/hub build` + bundle-check. All green; report ceiling values.
- [ ] **Step 4:** Commit docs — `docs(hub): via docs sync for #669/#670/#671/#672`.

---

## Self-review notes

- Spec coverage: #670→T1; #672→T2; #669→T3 (+T5-adjacent parity in T3 Step 5); #671 items 4,5→T4, items 1,2,3→T5, rider→T5 disposition note; docs/changeset→T6. All four issues' pins from the issue bodies appear as test steps.
- The #665 corruption fence survives in T3 Step 1 (the `not.toBe('0.21')` assertion is never removed).
- T3 and T4 both edit `_applyMoneyFields` — sequenced (T4 brief says "read it fresh").
- Ceiling exposure: T2 (+1 line collection.ts), T3 Step 5 (call line), T5 (writer method) — each step carries the offset mandate; T4 is net-zero.
