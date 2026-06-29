# Edge-crypto kernel optimization — plaintext working set, crypto at the boundary

> **Status:** design, for review (2026-06-30). Reconstructed from a verified storage-layer audit (transcript 2026-06-28/29) that walked the reorganized hub and traced the in-memory representation end to end. Pairs with the `with-*` reorg spec but is independent. **This spec proposes flipping a central noy-db invariant — it is the high-stakes one; nothing here ships without explicit go-ahead.** The security review (overnight) assesses the flip's implications; fold its findings in before implementation.

## The current invariant

> *Encryption (AES-256-GCM) happens inside `@noy-db/hub` before **any** store call.*

Uniform and maximally paranoid: every store — even a pure in-memory one — only ever holds `EncryptedEnvelope` ciphertext, enforced at build time by `check-architecture.mjs` Check 4 (`stores-ciphertext-only`). This is the property that lets any `to-*` backend be a dumb, untrusted ciphertext blob.

## The discrepancy the reorg walk surfaced

Two top-level kernel neighbors, `cache/` and `to-memory`, sit on **opposite sides of the encryption boundary** — and that exposes a redundancy:

- **`to-memory`** is a **store**: nested `Map`s of `EncryptedEnvelope` — **ciphertext**, *outside* the trust boundary, a pluggable satellite (verified: 0 files in `cache/` implement `NoydbStore`; it is `class Lru`, not a store).
- **`cache`** (the hub `Lru`) caches **decrypted records** — **plaintext**, *inside* the trust boundary, hub-internal.

They are separated by `crypto.subtle` and can never be interchangeable. And `collection.ts` holds the decrypted working set in **one** field (verified): eager default `private cache = new Map<id,{record,version}>()` (a full map of every decrypted record), or lazy `private lru: Lru | null` (bounded). The query DSL iterates this in-RAM **plaintext** map directly (`[...this.cache.values()].map(e => e.record)`).

**The redundancy:** with `to-memory`, one record is resident in RAM **twice** — ciphertext in the store's `Map` *and* plaintext in `collection.cache`. ~2× memory. For persistent stores (`to-file`) the two copies are sensible (ciphertext on disk, plaintext in RAM); for a pure in-memory store they are the **same data, doubly resident**. And the security value of the ciphertext copy there is near-zero: encrypting *for an in-process RAM store* is "encrypting to yourself in trusted memory" — an attacker with process-memory access already reads `collection.cache` in plaintext. It buys **contract uniformity**, not secrecy — and not for free.

The deeper cost is the **eager default**: opening a collection does `loadAll` + decrypts the *entire* collection into `this.cache`. The whole DB sits decrypted in RAM, and a memory dump reveals everything.

## What must actually be decrypted — the four-bucket tier analysis

Cutting the catalog by *how much plaintext each operation needs* (verified against `decryptRecord` call sites + the architecture invariant):

| bucket | what decrypts | features |
|---|---|---|
| 🟢 **NONE** (ciphertext / key / envelope only) | nothing | `party/sync` (replicates envelopes) · `fork/{bundle,snapshots,archive}` (ciphertext passthrough) · `audit/forget` (key-shred) · `audit/{attestation,sealed-record}` (sign hashes/keys) · `party/{team,session,custody}` (key wrap/unwrap) · `introspection` (schema only) · the store layer |
| 🔵 **RESULT / CURSOR** (just the records you return) | only the N matched rows | `read`/`get(id)` · **indexed** `query`/`scan` cursor · `formula/computed`·`derivations` (one source row) · `commit/history` diff/revert (two versions of one record) · `fork/shadow` · `commit/crdt` · `shape/blobs` · `shape/{i18n,money}` read transform · `search`/`embeddings` **query** |
| 🟡 **COLUMN(S) / INDEX** (specific fields, kept resident as index metadata — *the leak surface*) | the indexed field(s) | `lookup/indexing` (`Map<value, ids>`) · `lookup/embeddings` (vectors) · core `refs` (FK id) · `audit/{periods,guards}` (period-date / frozen field) · `shape/links` · `party/user-envelope`·`directory` (profile fields) |
| 🔴 **ALL DATA** (full scan — the enemy) | every record | **unindexed** `query`/filter · `lookup/aggregate` on an unindexed field · `search`/`embeddings` **index build** (once) · `formula/materialized-views` **full refresh** · `fork/vault-diff` whole-vault · *(today's default)* eager `loadAll` on open |

**The decisive observation:** 🔴 is not a fixed list of features — it's the list of *un-indexed / first-build / full-rebuild* operations. Every 🔴 entry has a 🔵/🟡 path once an index exists or once it goes incremental. 🟢 is ~a third of the catalog (`fork` + `sync` + key/seal ops) and runs untouched on ciphertext.

## The proposed model — plaintext core, crypto at the edge

> *Keep the working set as **plaintext in trusted process RAM**. Make encryption a **store-edge codec** applied only when data crosses a **real** boundary — disk (`to-file`), network (`sync`), export (`bundle`). The integrity envelope (hash-chain, signatures) is part of the same codec: applied on the way out, verified on the way in.*

```
        TRUSTED (your process RAM)        │  UNTRUSTED (the edge & beyond)
  ┌────────────────────────────────┐     │
  │  plaintext working set          │ ──encrypt──▶  to-file (disk)
  │  (the Collection's record map)  │ ◀─decrypt──   sync (cloud/peer)
  │  queries/derivations/diff run   │ ──encrypt──▶  bundle (export)
  │  here, directly, fast           │     │
  └────────────────────────────────┘     │
        ONE plaintext copy                   ciphertext ONLY at/past the edge
```

This is the **mainstream, proven** shape, not an exotic one: SQLCipher decrypts pages into a plaintext page cache and encrypts at the disk edge; Postgres TDE and every "encryption at rest + TLS in transit" database has the same form — **plaintext in the trusted process, ciphertext at the boundary.** (An earlier "ciphertext-resident in RAM" idea was the unusual one and was rejected: you can't usefully compute on encrypted data, and your own keyed RAM is the trusted space — encrypting against yourself is theater.)

### Consequences

1. **`to-memory` dissolves.** A pure in-memory DB crosses no boundary → no encryption → no ciphertext → no store object needed. The plaintext working set *is* the database. `to-memory` drops from the 5 essentials (the built-in `MemoryStore` already covers dev/test/prototyping — see "Already shipped").
2. **`cache` stops being a "cache" — it's the buffer pool.** In lazy mode, a *bounded* plaintext buffer paging from an encrypted persistent store (decrypt-in, evict-cold). In eager mode, the whole thing. Either way it's not redundant — it's the in-memory DB.
3. **Crypto becomes opt-in at the edges, like the subsystems.** Cross no boundary → pay no crypto. Pure in-memory + no audit ledger = **zero encryption**, plaintext only. "Control through smallness" applied to crypto itself.
4. **Derived structures already obey this.** Indexes (`_idx/<field>/<id>`), full-text (`cb.save(serializeIndex(...))`), and MV outputs are all **encrypted at the store** (guaranteed by Check 4) and **decrypted into RAM** to be used. So records *and* their indexes *and* search *and* MVs already follow "plaintext in RAM, ciphertext at the edge" — `to-memory` was the *sole* piece that didn't fit. Removing it makes the model uniform.

## The honest cost — what the flip changes

This **inverts the central invariant** from "encryption before *any* store call" (uniform, maximally paranoid) to "encryption at the trust boundary (codec)". The trade:

- **What weakens:** the *uniformity* guarantee. Today `stores-ciphertext-only` is absolute — a store can never receive plaintext. Under edge-crypto, the boundary moves: the in-memory working set is plaintext by design, and the codec is what guarantees ciphertext *past the edge*. The build-time guard must be re-expressed as "ciphertext at the **persistent/transport/export** edge," not "ciphertext at every store call." This needs a new, equally-mechanical guard — the security review must confirm it can be enforced as strongly.
- **What stays exactly the same:** the at-rest (disk), in-transit (sync), and export (bundle) guarantees — those edges always encrypt. Zero-knowledge against the *backend* is unchanged (the backend still only ever sees ciphertext). The keyring/permission model is untouched.
- **The Tier-🟡 leak is RAM-only and unchanged in size.** Indexed field values, vectors, ref-ids, profile fields are derived-plaintext metadata resident in RAM. They are resident today too (in `collection.cache` and the in-RAM index maps). Edge-crypto doesn't widen this; it just states the boundary honestly. Nothing queryable-in-plaintext ever reaches the store (the store-usable blind-index / SSE path stays gated and unbuilt).

## Already shipped (the enabler)

- **Built-in `MemoryStore` + optional `store`** — `createNoydb()` is zero-config, in-RAM out of the box (`packages/hub/src/store/memory-store.ts`, `createNoydb({ store? })` now optional). Landed on `main` (`e1f5ba90`). This is what makes dropping `to-memory` viable: the kernel covers dev/test; you install `to-file`/`to-postgres` only when you want persistence.

## Phasing (high level — detail in the plan)

- **P1 — built-in store (DONE).**
- **P2 — store-edge codec seam.** Formalize encrypt-on-write-out / decrypt-on-read-in as a codec at the `adapter`/`store` edge (the `feat/p2-edge-codec-seam` exploration is the seed). Re-express the `stores-ciphertext-only` guard as `ciphertext-at-the-persistent-edge`.
- **P3 — dissolve `to-memory`.** Demote from the 5 essentials; document migration (use the built-in store).
- **P4 — `cache` → buffer pool framing.** Rename/reframe; consider lazy-by-default (large-collection memory + the whole-DB-in-RAM exposure). This intersects the refactoring review.

## Risks

- **The invariant flip is load-bearing and widely assumed.** Many docs/specs state "encryption before any store call." All must be updated atomically with the guard change, or the architecture story becomes inconsistent.
- **Lazy-by-default is a behavior change** (offline-first eager reads are a feature). Evaluate separately; don't bundle silently.
- **Security review gating.** Do not re-express the ciphertext guard until the security review confirms the edge formulation is enforceable at the same strength.

## Relationship to the reorg

Independent. The reorg relocates *optional* subsystems into `with-*`; this spec reshapes the *kernel/plumbing* (`store/`, `cache/`, `to-memory`). If sequenced, reorg first (clean top-level kernel surface), then edge-crypto.
