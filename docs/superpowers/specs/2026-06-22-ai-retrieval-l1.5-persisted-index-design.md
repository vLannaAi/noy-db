# AI retrieval — L1.5: persisted lexical index + federation-ready hit — design

> **Status:** DESIGN — ready for plan.
> **One line:** Add an opt-in **`PersistedIndexStore`** so L1's lexical index survives
> sessions/devices (no cold rebuild scan): serialize the in-memory `InvertedIndex`,
> store it as **one opaque encrypted blob** under the collection DEK, validate
> freshness by a cheap **fingerprint**, refresh via a **debounced flush + flush-on-
> close**, and tear it down on `forget()`. Plus a small **federation-ready** change
> to `RetrieveHit` (add `rank`) so a future klum-db Lobby can fuse results across
> vaults. **Zero added store leakage** — the blob is opaque ciphertext (no per-term
> addressability).

## Context

L1 (shipped, PR #478) builds the lexical inverted index **in memory, per session**:
the first `retrieve()`/`warmIndex()` decrypts+tokenizes the whole collection once,
then all queries are O(postings). The cost is that **first scan every session** —
fine at the pilot's scale, but for large corpora or short-lived agent sessions it's
wasteful. L1 already shipped the seam for this: `IndexStore` (`getOrBuild`/
`markDirty`/`built`, `MemoryIndexStore`). L1.5 adds the persisted backend behind
that seam — no `retrieve()` API change for the caller.

This is the "**complete the full-text index**" layer of the AI-retrieval epic
([[project_search_ai_retrieval_epic]]): L0 scan ✅, L1 in-memory ✅, **L1.5 persisted
(this)**, L2 semantic (next), L3 hybrid, L4 ORAM/enclave (deferred).

## What exists (reused)

| Capability | Where | Reused as |
|---|---|---|
| `IndexStore` seam + `MemoryIndexStore` | `src/search/index-store.ts` | L1.5 adds `PersistedIndexStore` implementing the same interface |
| `InvertedIndex` (docs[] + per-field BM25 stats) | `src/search/inverted-index.ts` | gains `toSnapshot()`/`fromSnapshot()` for (de)serialization |
| `retrieve()`/`warmIndex()` (async) | `collection.ts` | already `await` the store — absorbs the sync→async build change |
| Encrypted side-car blob under collection DEK | the lazy `_idx` persisted-index path (`collection.ts` `encryptJsonString`/`decryptJsonString` + `adapter.put/get`) | the index blob reuses this encrypt/decrypt + key-scoping |
| Debounced background flush precedent | `withSnapshots` `SnapshotScheduler` (own timers, `onAfterWrite`, teardown on `db.close()`) | the index-flush debounce mirrors this |
| `forget()` crypto-shred path | `collection.ts` `forget()` (#357/#401) | gains an index-blob teardown call |

## Scope — in

| Item | Notes |
|---|---|
| `textIndexPersist?: boolean` collection option | default false → `MemoryIndexStore` (today); true → `PersistedIndexStore` |
| `IndexStore` interface: sync `getOrBuild` → **async `ensureBuilt(build): Promise<InvertedIndex>`** | `MemoryIndexStore` implements trivially; `retrieve()`/`warmIndex()` already async |
| `InvertedIndex.toSnapshot()/fromSnapshot()` + `src/search/serialize.ts` | structural (de)serialization of postings + stats (+ per-doc text for snippets) |
| `PersistedIndexStore` (`src/search/persisted-index-store.ts`) | in-memory index (L1 behavior) + injected `{ load, save, remove }` crypto/blob callbacks + debounced flush + fingerprint |
| Opaque encrypted blob at reserved key `_ftindex/<collection>` under the **collection DEK** | one ciphertext blob (sharding deferred); store learns only its size |
| **Fingerprint** = `{ count, maxVersion }` over the collection's records | stored in the blob envelope; recomputed from the eager cache on load → use blob if match, else rebuild + re-persist (handles cross-session/device staleness) |
| **Debounced flush** (after writes) + **flush-on-`db.close()`** | the persisted blob is a periodic snapshot; in-session the index is live in memory |
| `forget()` tears down the index blob | calls `store.remove()` + `markDirty` — an opaque all-records index must not survive crypto-shred (#401-class) |
| **Federation-ready `RetrieveHit`:** add `rank: number` (1-based) | enables Reciprocal-Rank-Fusion across vaults (klum Lobby) and across modalities (L3 hybrid). ids stay **vault-local** (the Lobby qualifies them with `{vault, ...}`) |

## Scope — out (deferred)

| Item | Deferred to | Why |
|---|---|---|
| Incremental posting-diff flush | later | v1 flush re-serializes the whole index; debounce keeps it ~1 write/window |
| Sharded blob (multi-part opaque index) | later | one blob is fine until index size forces it; the `{load,save}` seam allows sharding without an API change |
| `fuseRetrieval(lists, {strategy})` fusion reducer | **L3** | serves BOTH L3 hybrid (merge lexical⊕semantic) AND klum federation (merge across vaults) — one primitive, lands with hybrid |
| `lobby.retrieve()` cross-vault fan-out | **klum-db** | crosses the vault/party boundary → orchestration; consumes noy's per-vault `retrieve()` + `fuseRetrieval` + `rank` via `@noy-db/hub/kernel` |
| Semantic/vector persistence | L2 | L2 designs its own encrypted-vector persistence (vectors are expensive → always persisted) |

## Architecture

### Interface evolution (sync → async build)

```ts
// index-store.ts
interface IndexStore {
  ensureBuilt(build: () => ReadonlyArray<IndexDoc>): Promise<InvertedIndex>  // was sync getOrBuild
  markDirty(): void
  flush(): Promise<void>     // NEW — force-persist now (called on db.close())
  readonly built: boolean
}
```
`MemoryIndexStore.ensureBuilt` = the old `getOrBuild` wrapped in `Promise.resolve`; its `flush()` is a no-op. `retrieve()`/`warmIndex()` change `const idx = this.store.getOrBuild(...)` → `const idx = await this.store.ensureBuilt(...)` (already in async methods).

### `PersistedIndexStore`

Constructed by the collection (which owns the DEK + adapter) with injected callbacks so the store stays crypto-free:

```ts
new PersistedIndexStore({
  load:   () => Promise<{ bytes: Uint8Array; fingerprint: Fingerprint } | null>,  // decrypt _ftindex/<coll>
  save:   (bytes: Uint8Array, fp: Fingerprint) => Promise<void>,                  // encrypt + put
  remove: () => Promise<void>,                                                    // delete blob (forget)
  currentFingerprint: () => Fingerprint,                                          // {count, maxVersion} from cache
  debounceMs: number,                                                            // e.g. 1000
})
```

- **`ensureBuilt(build)`**: in-memory index? → return it. Else `load()` → if blob present AND `blob.fingerprint == currentFingerprint()` → `deserializeIndex(bytes)` (skip the scan). Else → `InvertedIndex.build(build())` (the L1 scan) → schedule an immediate flush. Cache in memory.
- **`markDirty()`**: drop the in-memory index (next `ensureBuilt` rebuilds, L1 semantics) + schedule a debounced flush.
- **debounced flush**: on fire → `ensureBuilt(build)` (rebuild if dirty) → `serializeIndex` → `save(bytes, currentFingerprint())`. Coalesces a burst of writes into ~one blob write.
- **`flush()`**: cancel debounce, flush now (called from `db.close()`).

### Encryption & leakage

The collection serializes the snapshot, `encryptJsonString` under the **collection DEK** (so it survives per-record CEK rotation and is ciphertext to the store), and `adapter.put` at `_ftindex/<collection>`. The store sees **one opaque blob of size S** — never terms, postings, or plaintext, and no per-term addressability (the anti-blind-index invariant). Same zero-knowledge contract as L1; the only new store artifact is the opaque blob.

### Fingerprint & cross-session staleness

`Fingerprint = { count: number, maxVersion: number }` over the collection's records (cheap from the eager-hydrated cache: `cache.size` + max `_v`). Stored in the blob envelope. On `load`, recompute from the current cache and compare. Match → trust the blob (another session built it from the same record-set). Mismatch (a write happened on another device/tab) → discard the blob, rebuild, re-persist. This is best-effort + self-healing: a stale blob is never used, only ever rebuilt. (Hash-of-ids is a stronger fingerprint but `{count, maxVersion}` catches all add/update/delete cases since every write bumps `_v` and delete changes count.)

### `forget()` teardown

`forget(id)` crypto-shreds a record but keeps the DEK — so a DEK-encrypted `_ftindex` blob would still decrypt a forgotten subject's indexed terms. `forget()` therefore calls `searchIndexStore.remove()` (delete the blob) + `markDirty()`; the next `retrieve()` rebuilds from the post-forget records. (The in-memory index is also dropped by `markDirty`.)

## Federation-ready `RetrieveHit`

`RetrieveHit` gains `rank: number` (1-based position in the returned, score-sorted list). Rationale ([[project_search_ai_retrieval_epic]]): cross-vault federation cannot compare raw BM25 scores (local IDF is corpus-relative, and sharing global `df` would leak across the vault boundary), so the Lobby fuses by **rank** (Reciprocal Rank Fusion). The same `rank` powers L3's hybrid lexical⊕semantic fusion. ids remain **vault-local**; the klum Lobby qualifies them (`{vault, id, rank, score, snippet}`) when fanning out. No `vault` field is added to noy's `RetrieveHit` — that's the orchestrator's concern. This is the only retrieve()-output change in L1.5.

## Testing

- `serialize`/`deserialize` round-trip: a built index → snapshot → restored index returns identical query results.
- **Cold-load skips the scan:** seed records, build+persist (session 1); new collection instance with the same store → `retrieve()` loads the blob and returns correct hits **without** a full re-tokenize (assert via a build-counter / spy that `InvertedIndex.build` is NOT called when the fingerprint matches).
- **Stale fingerprint → rebuild:** persist, then mutate the underlying record-set out-of-band (bump count/version) → next load rebuilds.
- **Debounced flush:** N rapid writes → ~1 blob `save` within the window (assert save-call count).
- **flush-on-close:** `db.close()` persists the latest index.
- **`forget()` removes the blob** and the next retrieve rebuilds without the forgotten record.
- **Leakage:** wrap the store; assert the only new key written is `_ftindex/<collection>`, its body is ciphertext (no plaintext terms), and `textIndexPersist:false` writes nothing.
- `RetrieveHit.rank` is 1-based and monotonic with score order.
- `MemoryIndexStore` still passes its existing tests under the async `ensureBuilt` signature (no behavior change).

## Non-code obligations

- `docs/subsystems/search.md`: document `textIndexPersist`, the opaque-blob + fingerprint model, debounced flush, `forget()` teardown, and the L1.5 line of the epic map; note `rank` on `RetrieveHit`.
- `features.yaml`: extend the `search-index` node (still `preview`/`experimental`) with the persistence capability + this spec ref.
- Showcase: extend the retrieve showcase (or add one) showing persist → new-session warm load (no rebuild).
- Kernel ceiling: the collection gains only thin call-sites (construct `PersistedIndexStore`, inject callbacks, `forget()` teardown, `db.close()` flush); keep `collection.ts` under its ceiling, raise minimally if needed.
- Tree-shaking: all new logic in `src/search/`; `MemoryIndexStore` stays the default (zero cost when `textIndexPersist` unset).
