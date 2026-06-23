# AI retrieval — L3: hybrid lexical+semantic retrieval + fuseRetrieval — design

> **Status:** DESIGN — ready for plan.
> **One line:** `retrieve(q, { mode: 'hybrid', within? })` runs the lexical (L1)
> and semantic (L2) retrievals, fuses them by **Reciprocal Rank Fusion**, and
> optionally intersects the result with a structured `Query<T>` (`retrieve ∩
> where`). The fusion step is a **standalone, kernel-exported pure reducer**
> (`fuseRetrieval`) so klum-db's Lobby reuses the same primitive to fuse across
> vaults. Zero new store leakage — L3 is pure in-trusted-tier computation over
> L1/L2 outputs.

## Context

L3 is the final client-tier layer of the AI-retrieval epic
([[project_search_ai_retrieval_epic]]): L0 scan ✅ → L1 lexical ✅ → L1.5
persisted ✅ → L2 semantic ✅ → **L3 hybrid (this)** → L4 ORAM/enclave
(deferred). It closes the retrieval surface: a single `retrieve()` that an AI
agent (or a human) calls with `mode: 'lexical' | 'semantic' | 'hybrid'`, where
hybrid is the best general default for natural-language queries (lexical catches
exact terms/IDs, semantic catches paraphrase).

It also lands the **federation primitive** noy-db owes klum-db. The boundary
([[project_search_ai_retrieval_epic]], [[project_boundary_epic]]): noy-db owns
the per-vault `retrieve()`, the `rank` field (added in L1.5 for exactly this),
and the `fuseRetrieval` reducer; klum-db owns `lobby.retrieve()` — the
cross-vault fan-out that qualifies ids with `{vault, ...}` and calls
`fuseRetrieval` across the per-vault result-sets. L3 ships noy's half only.

What exists (verified): `retrieve(query, opts)` returns `RetrieveHit<T>[]` with a
1-based `rank` on **both** the lexical and semantic paths; `RetrieveOptions.mode`
is `'lexical' | 'semantic'`; `query()` is a synchronous eager-mode builder
(`where(field, op, value)`, `and/or/filter/orderBy/limit`, `toArray(): T[]`).
**Nothing named `fuseRetrieval`/`rrf` exists** — clean slate. Kernel ceilings are
tight (collection.ts 5252/5255, vault.ts 4600/4610) — L3 logic lives in
`src/search/`; collection.ts gains only thin call-sites.

## Scope — in

| Item | Notes |
|---|---|
| `fuseRetrieval(lists, opts?)` pure reducer | `src/search/fuse.ts`; **Reciprocal Rank Fusion**; generic over arity (≥1 list) so the same fn serves 2-modality fusion AND N-vault federation; zero deps, hub-portable |
| `mode: 'hybrid'` in `retrieve()` | runs the lexical path + `retrieveSemantic`, `fuseRetrieval([lex, sem], { limit })`; thin branch in `collection.ts` |
| **Hybrid requires embeddings** | `mode:'hybrid'` on a collection with no `embeddings` configured → throws a clear hybrid-specific error (its own message, not the semantic one verbatim) |
| `within?: Query<T>` payload filter | `RetrieveOptions` gains `within`; after retrieval, intersect hits with the id-set of `within.toArray()`; re-stamp `rank`. Works in **all three** modes (post-filter on `RetrieveHit[]`). Eager-mode only |
| Export `fuseRetrieval` + `FuseOptions` from the package entry AND `@noy-db/hub/kernel` | the klum federation contract surface (mirrors the coordination-port precedent) |
| features.yaml + subsystem doc + showcase | extend the `search-index`/`vector-search` story with hybrid; document RRF + `within`; a hybrid showcase |

## Scope — out (deferred)

| Item | Deferred to | Why |
|---|---|---|
| `lobby.retrieve()` cross-vault fan-out | **klum-db** | crosses the vault/party boundary → orchestration; consumes noy's `retrieve()` + `fuseRetrieval` + `rank` via `@noy-db/hub/kernel` |
| Weighted / score-normalized fusion | later | RRF (rank-based) is the robust default; BM25 and cosine scales aren't comparable, and min-max normalization shifts with the result set. A per-list weight knob can be added behind `FuseOptions` later without an API break |
| HNSW / ANN | later | semantic stays brute-force (L2 decision); fusion is orthogonal |
| ORAM / attested-enclave compute tier | **L4** | research; access-pattern hiding |
| Lazy-mode `within`/hybrid | later | `query()` and semantic are eager-mode only today; hybrid inherits that |

## Architecture

### Components (logic in `src/search/`, call-sites thin)

```
src/search/
  fuse.ts          # NEW — fuseRetrieval(lists, opts?): RRF reducer over RetrieveHit[][]
  retrieve-types.ts# mode adds 'hybrid'; RetrieveOptions gains within?: Query<T>; + FuseOptions
  (collection.ts)  # thin: retrieve() 'hybrid' branch + within post-filter
```

### `fuseRetrieval` — the shared primitive

```ts
export interface FuseOptions {
  readonly strategy?: 'rrf'   // only 'rrf' in v1
  readonly k?: number         // RRF constant, default 60
  readonly limit?: number     // truncate fused output
}

export function fuseRetrieval<T>(
  lists: ReadonlyArray<ReadonlyArray<RetrieveHit<T>>>,
  opts?: FuseOptions,
): RetrieveHit<T>[]
```

**RRF algorithm:** for each list, for each hit `d` at 1-based `rank_d`, accumulate
`score += 1 / (k + rank_d)` into a per-`id` accumulator (k=60 default). Group by
`id`. Sort by accumulated score descending; ties broken by `id` ascending
(deterministic). Re-stamp `rank` 1-based on the sorted output. Slice to `limit`
if set.

**Merged-hit field policy:** when an id appears in multiple lists, keep the
**lexical-style** presentation fields where present — prefer a non-empty
`snippet`, a `field` other than `'(vector)'`, and any `locale` — because the
lexical hit carries human-readable context the vector hit lacks. The merged
`score` is the **RRF score** (documented: not BM25, not cosine). `record` (if any
list carried `includeRecord`) is preserved.

Pure, deterministic, no I/O — which is exactly why klum can call it across
vault result-sets. Generic over arity: `fuseRetrieval([lex, sem])` for
modalities, `fuseRetrieval(perVaultLists)` for federation — same code.

### Hybrid execution in `retrieve()`

`retrieve(q, { mode:'hybrid', limit, within? })`:
1. If `this.embeddings` is not configured → throw the hybrid-specific error.
2. Run the existing lexical path → `lexHits: RetrieveHit[]` (ranked).
3. Run `retrieveSemantic(q, opts)` → `semHits: RetrieveHit[]` (ranked).
4. `fused = fuseRetrieval([lexHits, semHits], { limit })`.
5. Apply `within` (below) if present.
6. Return `fused`.

Both sub-retrievals already exist and already return ranked `RetrieveHit[]`; the
hybrid branch is orchestration only.

### `within: Query<T>` — `retrieve ∩ where`

`within` is a `Query<T>` (the eager-mode builder, e.g.
`c.query().where('status','==','open').and(q => q.where('amount','>',100))`).
After retrieval (any mode), retrieve computes the **id-set of records matching the
query** and keeps only hits whose `id ∈ ids`, then re-stamps `rank` 1-based on the
survivors. This reuses the entire structured query engine — every operator, index
fast-path, `and/or` — instead of re-implementing predicates inside `retrieve()`.
It is a post-filter on `RetrieveHit[]`, so it composes with `lexical`,
`semantic`, and `hybrid` uniformly. Eager-mode only (matches `query()` and the
semantic path).

**Id recovery (the mechanism):** noy-db's `id` is the external Map key
(`put(id, record)`), not a record field, and `Query.toArray()` returns *records*
(further transformed by money-decode/joins into new objects) — so ids cannot be
read back from `toArray()`. The fix is an internal id-projection terminal,
`Query<T>._idArray(): string[]`, that runs the *same plan* (`executePlanWithSource`,
which returns the **original cache record references**, before money-decode/joins)
and maps each matching record back to its id by **reference identity** against an
id-paired snapshot. To supply that pairing, `QuerySource<T>` gains an optional
`snapshotEntries?(): readonly { id: string; record: T }[]`; `collection.query()`
provides it from `this.cache.entries()`. `_idArray()` throws if the source lacks
`snapshotEntries` (only collection-backed queries support `within`; a raw
`new Query(plainSource)` does not). The public `within: Query<T>` API is
unchanged — this is purely how `retrieve()` reads ids out of it.

### Privacy / leakage (the contract)

L3 adds **zero new store artifacts**. It is pure in-trusted-tier computation over
the outputs of L1 (in-memory inverted index) and L2 (decrypted in-memory
vectors), plus `within` which runs against the in-memory eager cache. No new
`_`-namespace, no new blob, no new query to the store. The store sees exactly
what lexical + semantic already cause it to see. The federation export
(`fuseRetrieval`) is a pure function — it transmits nothing.

### Federation seam (noy's half only)

After L3, noy-db exposes the complete primitive set klum needs:
- per-vault `retrieve()` (returns ranked, vault-local `RetrieveHit[]`),
- `rank` on every hit (RRF input; raw scores are corpus-relative and not shared
  across the vault boundary),
- `fuseRetrieval` (id-keyed; klum pre-qualifies ids per vault before fusing),
all reachable via `@noy-db/hub/kernel`. `lobby.retrieve()` (fan-out, vault
qualification, scatter-gather) is **klum's** job and out of scope here.

## Decisions (resolved)

- **RRF (k=60)** fusion — rank-based, no cross-modality score comparison; the
  same primitive federation uses. Weighted/normalized fusion deferred (can slot
  behind `FuseOptions` later, no break).
- **`within: Query<T>`** for `retrieve ∩ where` — reuse the structured query
  engine via an id-set intersection; not a re-implemented predicate.
- **Hybrid throws** when `embeddings` is absent — explicit misconfiguration, not
  a silent degrade to lexical.
- **`fuseRetrieval` is generic over list arity** (≥1) and **exported from
  `@noy-db/hub/kernel`** — one primitive for modality fusion and vault federation.
- **Merged-hit score is the RRF score** (documented); presentation fields prefer
  the lexical hit.

## Testing

- `fuse.ts`: RRF math on known lists → known fused order/score; single-list
  passthrough (rank re-stamped, order preserved); id-dedup across lists (a doc in
  both lists outscores a doc in one); `limit` truncates; tie-break determinism;
  merged hit keeps the lexical snippet/field over `'(vector)'`/`''`.
- Hybrid: `mode:'hybrid'` without `embeddings` → throws the hybrid error;
  hybrid merges lex+sem and a doc strong in both outranks a doc strong in only
  one; `limit` honored.
- `within`: hybrid ∩ `where` drops ids not in the query set and re-ranks 1-based;
  `within` composes with `lexical` and `semantic` modes too; an empty `within`
  result yields no hits; **id recovery survives a money field** — a collection
  with a money field (which makes `toArray()` return decoded copies) still
  intersects correctly via `_idArray()` reference identity; `_idArray()` on a
  raw `new Query(plainSource)` (no `snapshotEntries`) throws.
- Leakage: wrap the store; a hybrid `retrieve()` (with `within`) writes **no new
  store keys** beyond what lexical+semantic already touch.
- Export: `fuseRetrieval` + `FuseOptions` reachable from both the package entry
  (`@noy-db/hub`) and `@noy-db/hub/kernel` (the grep-the-barrel rule from the L2
  export-gap lesson — assert via a showcase/import test going through the package
  entry, not `../src`).
- Tree-shaking: hybrid/fusion logic in `src/search/`; lexical-only bundles
  unaffected.

## Non-code obligations

- `features.yaml`: extend `search-index` (or `vector-search`) with the hybrid
  capability + `fuseRetrieval` federation primitive + this spec ref; correct any
  invariant that says retrieval is single-mode.
- `docs/subsystems/`: document `mode:'hybrid'`, RRF (and that the fused `score`
  is an RRF score, not BM25/cosine), `within` (`retrieve ∩ where`), the
  `@noy-db/hub/kernel` `fuseRetrieval` export + the federation seam, and the L3
  line of the epic map.
- Showcase: a hybrid-retrieve walkthrough — same deterministic stub encoder as
  showcase 124 — showing hybrid beating lexical-only and semantic-only on a
  mixed query, plus a `within` payload-filtered retrieve.
- Kernel ceiling: keep `collection.ts`/`vault.ts` under ceiling (logic in
  `src/search/fuse.ts`); raise minimally only if the thin call-sites force it.
- **Public-export check** (L2 lesson): every new public symbol
  (`fuseRetrieval`, `FuseOptions`, `mode:'hybrid'`, `within`) must be re-exported
  from `src/index.ts` AND, for `fuseRetrieval`, the kernel entry — grep new
  symbols against the barrels in the implementer contract.
