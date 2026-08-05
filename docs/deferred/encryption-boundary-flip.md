# Deferred: moving the encryption boundary to the edge

> **Status: parked, needs an explicit decision.** Originally specced 2026-06-30
> from a storage-layer audit that traced the hub's in-memory representation end
> to end. Phase 1 shipped; phases 2–4 did not. This proposal would **flip the
> project's central invariant** — it does not proceed without a deliberate
> go-ahead and a security review.

## What is being proposed

Today:

> Encryption happens inside `@noy-db/hub` before **any** store call.

Proposed:

> Keep the working set as **plaintext in trusted process RAM**. Make encryption
> a **store-edge codec** applied only when data crosses a *real* boundary —
> disk, network, export. The integrity envelope (hash-chain, signatures) is part
> of the same codec: applied on the way out, verified on the way in.

```
      TRUSTED (your process RAM)         │  UNTRUSTED (the edge and beyond)
┌──────────────────────────────────┐     │
│  plaintext working set            │ ──encrypt──▶  to-file (disk)
│  (the Collection's record map)    │ ◀─decrypt──   sync (cloud/peer)
│  queries/derivations/diff run     │ ──encrypt──▶  bundle (export)
│  here, directly, fast             │     │
└──────────────────────────────────┘     │
      ONE plaintext copy                     ciphertext ONLY at/past the edge
```

## The observation that prompted it

Two kernel neighbours sit on opposite sides of the boundary:

- **`to-memory`** is a *store* — nested `Map`s of `EncryptedEnvelope`, i.e.
  ciphertext, outside the trust boundary, pluggable.
- **`cache`** (the hub `Lru`) caches *decrypted* records — plaintext, inside the
  trust boundary, hub-internal.

They are separated by `crypto.subtle` and can never be interchangeable. With
`to-memory`, one record is therefore resident in RAM **twice** — ciphertext in
the store's map and plaintext in the collection's cache. Roughly 2× memory.

For a persistent store the two copies are sensible (ciphertext on disk,
plaintext in RAM). For a pure in-memory store they are the same data, doubly
resident — and the security value of the ciphertext copy is near zero.
Encrypting for an in-process RAM store is encrypting to yourself in trusted
memory: an attacker who can read the store's map can already read the plaintext
cache. It buys contract *uniformity*, not secrecy, and not for free.

The deeper cost is the eager default: opening a collection decrypts the entire
collection into RAM, so the whole database sits decrypted and a memory dump
reveals everything.

## What actually needs decrypting

The audit cut the catalog by how much plaintext each operation genuinely needs:

| Bucket | Decrypts | Examples |
|---|---|---|
| **None** — ciphertext/key only | nothing | sync (replicates envelopes) · bundle/snapshots/archive (ciphertext passthrough) · forget (key-shred) · attestation, sealed-record (signs hashes) · team/session/custody (key wrap) · introspection (schema only) · the whole store layer |
| **Result / cursor** | only the matched rows | `get(id)` · indexed query/scan · computed and derivations (one source row) · history diff/revert · shadow · CRDT · blobs · i18n/money read transforms · search and embeddings *query* |
| **Column / index** — *the leak surface* | the indexed fields, kept resident | indexing (`Map<value, ids>`) · embedding vectors · FK ids · period dates and frozen fields · links · profile fields |
| **All data** — the enemy | every record | *un*indexed query or aggregate · search/embeddings index *build* · MV full refresh · whole-vault diff · today's eager `loadAll` on open |

The decisive point: the last bucket is not a fixed list of features. It is the
list of *unindexed / first-build / full-rebuild* operations, and every entry in
it has a cheaper path once an index exists or once it becomes incremental. The
first bucket is roughly a third of the catalog and runs on ciphertext untouched.

## Why this shape is not exotic

It is the mainstream database form. SQLCipher decrypts pages into a plaintext
page cache and encrypts at the disk edge. Postgres TDE, and every "encryption at
rest plus TLS in transit" system, has the same structure: plaintext in the
trusted process, ciphertext at the boundary.

An earlier "ciphertext-resident in RAM" variant was considered and rejected —
you cannot usefully compute on encrypted data, and your own keyed RAM *is* the
trusted space.

## What it would cost

**What weakens: the uniformity guarantee.** Today `stores-ciphertext-only`
(CI guard 4) is absolute — a store can never receive plaintext, and that is
checkable by grepping imports. Under edge-crypto the boundary moves, the
in-memory working set is plaintext by design, and the codec is what guarantees
ciphertext past the edge. The guard would have to be re-expressed as
"ciphertext at the **persistent/transport/export** edge". **A security review
must confirm that formulation is enforceable at the same strength before any of
this proceeds.** A weaker guard that merely looks similar is the failure mode.

**What stays identical:** at-rest, in-transit, and export guarantees. Those
edges always encrypt. Zero-knowledge against the backend is unchanged — the
backend still only ever sees ciphertext. The keyring and permission model is
untouched.

**The column/index leak is RAM-only and unchanged in size.** Indexed values,
vectors, ref-ids, and profile fields are resident in RAM today too. Edge-crypto
does not widen that surface; it states the boundary honestly. Nothing
queryable-in-plaintext reaches the store — the store-visible blind-index path
stays separately gated.

## Phasing, and what already happened

- **P1 — built-in `MemoryStore`, `store` option optional. DONE.** `createNoydb()`
  is zero-config and in-RAM out of the box. This is the enabler: the kernel
  covers dev/test, so persistence becomes an install.
- **P2 — the store-edge codec seam.** Formalize encrypt-on-write-out /
  decrypt-on-read-in as a codec at the store edge, and re-express the guard.
  Not built.
- **P3 — dissolve `to-memory`.** A pure in-memory database crosses no boundary,
  so it needs no encryption, no ciphertext, and no store object. Not built —
  `to-memory` remains one of the four essential stores.
- **P4 — reframe `cache` as a buffer pool.** In lazy mode a bounded plaintext
  buffer paging from an encrypted store; in eager mode the whole thing. Either
  way it is not a cache, it is the in-memory database. Not built.

## Risks to weigh before reviving this

- **The invariant is load-bearing and widely assumed.** It is stated in the
  root `README`, `CLAUDE.md`, `ARCHITECTURE.md`, every family doc, and the
  published documentation site. All of it would have to change atomically with
  the guard, or the architecture story becomes incoherent — and an incoherent
  security story is worse than a conservative one.
- **Lazy-by-default is a separate behaviour change.** Offline-first eager reads
  are a feature, not an accident. Evaluate it on its own; do not let it ride
  along silently.
- **The 2× memory cost this fixes is only paid by `to-memory` users.** Weigh the
  benefit honestly against the cost of moving the project's most-repeated
  guarantee.
