# i18n per-layer resolution for the `mv` and `join` layers (#285) — design spike

> **Spike, not a build spec.** #285's per-layer `onMissing` wiring splits cleanly: the
> `guard` / `derivation` / `export` layers are *tractable plumbing* (thread a layer-tagged
> read facade), while the `mv` and `join` layers were flagged "**design required**" by the
> Phase-D (D0) spike because the materialized-view executor and the join expander read
> **raw** locale maps and have **no resolution call site at all**. This doc resolves that
> design question so `mv`/`join` can be sized and built. The `guard`/`derivation`/`export`
> half is the companion slice and is out of scope here.

Issue: [#285](https://github.com/vLannaAi/noy-db/issues/285) (i18n hardening v1.x, milestone #18). Builds on the i18n hardening engine (#282/#283 → PR #284, milestone #17) and the `Layer`/`resolvePolicy` machinery already shipped.

## The gap, precisely (current code)

The per-layer policy engine **already exists** — `i18n/policy.ts` defines `Layer = 'read' | 'guard' | 'join' | 'mv' | 'derivation' | 'export'` and `resolvePolicy(onMissing, layer)` resolves the effective `OnMissing` for any layer. What is missing is the **resolution call site** for every layer except `read`:

- **`read`** is wired: `Collection.get`/`list` → `applyLocaleToRecord(record, locale)` (`collection.ts`) → `applyI18nLocale` / dict resolver, with the locale gate I just touched for #291.
- **`mv`**: the executor reads source rows with **no locale**. `materializeQueryResult` calls `q.toArray()` (`materialized-views/executor.ts:56`) and the union path calls `coll.query().toArray()` (`executor.ts:113-119`). `Query.toArray()` **carries no locale context by construction** — it decodes money with `'raw'` and deliberately fabricates no locale virtuals (`query/builder.ts:579`). So every i18n field reaching `query()` / `map()` / `groupBy` / `aggregate` is a **raw `{locale}` map**.
- **`join`**: `applyJoins` expands a right-side record onto the row; those joined i18n fields are likewise raw, with no `join`-layer resolution call site.

Two concrete failure modes follow:
1. **`groupBy` on an i18n field buckets on the raw map** — `groupAndReduce` keys on the raw value, so an `i18nText` group key is an object, producing unstable / per-shape buckets rather than one bucket per logical value.
2. **`mv:'throw'` (and `join:'throw'`) never fire** — a policy can declare them, but no code path evaluates an i18n field at those layers, so the policy is dead.

## Why this needs design, not just plumbing

`read` resolution is **per-reader**: a locale arrives with the `get`/`list` call. MVs are the opposite — **materialized once and stored**, then served to many readers at many locales. There is no single reader locale at materialization time. So "resolve i18n in the MV like we do on read" has no well-defined locale. This is the crux the plumbing-only framing misses.

The resolution splits into **two independent sub-problems** that must not be conflated:

### Sub-problem A — i18n fields *carried through* to the MV output (display)
The MV projects an i18n field and the **output collection** is what gets displayed. The clean model is **resolve-at-the-edge**: keep the raw `{locale}` map through the pipeline, declare the field as `i18nText`/`dictKey`/`staticDict` **on the MV output collection**, and let the normal read path resolve it per-reader when the output is read. This already works today (the output collection is an ordinary collection) and needs **no executor change** — only documentation + a conformance test. It is also the only model that preserves multi-locale output.

### Sub-problem B — i18n fields *consumed by the MV's own logic* (compute)
The MV's `query()` / `map()` / `groupBy` / `aggregate` reads an i18n value to **compute** something (group key, sort key, a derived field). Here a value is genuinely needed *at materialization time*, so a locale must be chosen. There is no per-reader answer; the MV must declare one. This is the real design decision.

The `join` layer is a variant of B: a join expands a right-side i18n field onto a row mid-query. But unlike an MV, a query **can** carry a locale (it just doesn't today). So the join layer's locale is "the query's locale, when present."

## Recommended v1 design

### 1. Display (Sub-problem A): document resolve-at-output, add a conformance test
No engine change. State the contract: **MVs preserve raw i18n maps; declare the field on the MV output collection to resolve per-reader at read time.** Add an MV-display conformance test (project an `i18nText` field through a `query`-form and a `union`-form MV; declare it on the output; assert read-time resolution at two locales + locale-less raw). This closes the "where does MV display i18n go" question with the least surface.

### 2. Compute (Sub-problem B): an explicit MV resolution locale
Add an optional `i18nLocale?: string` to `MaterializedViewStrategy` (both `query` and `union` forms). Semantics:
- **Set** → before `query()`/`map()`/`groupBy`/`aggregate` run, the executor resolves the source rows' i18n + dict fields to `spec.i18nLocale` at the **`mv` layer** (`resolvePolicy(field.onMissing, 'mv')`). This is the single, declared, deterministic locale the MV computes in. `mv:'throw'` now has its call site here.
- **Unset** → raw maps flow through unchanged (today's behavior). To avoid the silent-wrong-bucket trap, **`groupBy`/`orderBy` `{by:'label'}` on a raw `i18nText` field throws `LocaleNotSpecifiedError`** with a message steering the author to either (a) group by a stable **`dictKey`/`staticDict` code** (the correct pattern — group by code, label at read) or (b) declare `i18nLocale`. Grouping by a `dictKey`/`staticDict` **code** is always allowed and stable (it already is — the code is a scalar).

> The "group by a code, not a label-map" steer is the same principle #291's `staticDict` and `dictKey` already encode: the **stable key is the code**; the label is a read-time projection. The MV layer should reinforce that, not silently bucket on maps.

### 3. Join layer: thread the query locale into `applyJoins`
`Query.toArray()` carries no locale today. Add an internal locale channel to the query terminal (the same locale `get`/`list` already accept) and, in `applyJoins`, resolve joined i18n fields at the **`join` layer** (`resolvePolicy(field.onMissing, 'join')`) using that locale. When the query is locale-less, joined i18n fields stay raw (consistent with a locale-less read). This is the larger of the two engine changes because it touches the query terminal's locale plumbing; it can be a **second slice** after the MV half if needed.

### 4. `onMissing` call sites (the dead-policy fix)
Wire `resolvePolicy(field.onMissing, 'mv')` at the executor resolution point (§2) and `resolvePolicy(field.onMissing, 'join')` at the `applyJoins` expansion point (§3). These are the two missing call sites #285 names. `guard`/`derivation`/`export` remain the companion slice.

## Interactions to respect
- **Union-MV money (#350)** and **`staticDict` query seam (#291)** both just touched this exact executor/`groupAndReduce`/`buildDictLabelResolver` path. The `i18nLocale` resolution in §2 must run at the **same boundary** where `moneyFields` decode and after the arm `map()` — i.e. on the unified rows before `groupAndReduce`, mirroring how `moneyFields` are threaded. Reuse, don't fork, that seam.
- **`staticDict` `displayLocale`** (#291): for a `{by:'label'}` MV/query over a `staticDict` field, the field's `displayLocale` is the natural default for `spec.i18nLocale` / the query locale when none is set — keeps the locale-less consumer working without declaring `i18nLocale`. Worth honoring so #291 and #285 compose.
- **The locale gate** (collection.ts, just edited for #291): output-read resolution (§1) flows through it unchanged.

## v1 scope
| Item | In | Note |
|---|:--:|---|
| §1 MV display = resolve-at-output (doc + conformance test) | ✓ | no engine change |
| §2 `i18nLocale` on `MaterializedViewStrategy` + `mv`-layer resolution before group/aggregate | ✓ | the core MV decision |
| §2 guard: `groupBy`/`orderBy {by:'label'}` on raw `i18nText` w/o `i18nLocale` throws (steer to code) | ✓ | prevents silent wrong buckets |
| §4 `mv`-layer `onMissing` call site | ✓ | dead policy → live |
| §3 `join`-layer resolution + query-locale threading | ◑ | larger; acceptable as a second slice |
| guard / derivation / export layer wiring | ✗ | companion #285 slice (tractable plumbing) |
| Per-reader multi-locale materialized output (storing all locales) | ✗ | §1 (resolve-at-output) already serves this; no need |

## Acceptance (for the eventual build)
- MV projecting an `i18nText`/`staticDict` field, declared on the output → resolves at read for `en`/`th`, raw when locale-less (§1).
- `withMaterializedView({ …, i18nLocale: 'th' })` computing a derived field from an i18n source resolves at `'th'` with `mv`-layer `onMissing` honored; `mv:'throw'` throws on a missing `'th'` label (§2/§4).
- `groupBy` on a `dictKey`/`staticDict` code buckets stably (works today); `groupBy({by:'label'})` on a raw `i18nText` field without `i18nLocale` throws a steering `LocaleNotSpecifiedError` (§2).
- (slice 2) a join over an i18n field resolves at the query locale at the `join` layer; raw when locale-less (§3).

## Open decisions (for the plan)
- **`i18nLocale` vs reuse a vault default**: descriptor-level `i18nLocale` is simplest and explicit; a vault-level "materialization locale" could layer on later. Lean descriptor-level.
- **Throw vs silent-raw for `groupBy {by:'label'}` w/o locale**: lean **throw** (a wrong bucket is a silent correctness bug; a clear error with the code-grouping steer is friendlier than dormant data).
- **Slice the `join` half separately?**: yes if the query-terminal locale plumbing proves invasive — the MV half (§1/§2/§4) is independently valuable and lower-risk.
- **Estimated size**: §1 = S (doc + test). §2+§4 = M (descriptor field + one resolution pass at the established executor seam + the groupBy guard). §3 = M–L (query-terminal locale channel + applyJoins resolution). So #285's mv/join half is **M (MV slice) + M–L (join slice)** — no longer the unbounded "design required" it was before this spike.
