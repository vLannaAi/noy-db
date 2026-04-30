# Dimension 14 (derived data) — v1 implementation design

> Graduates from the `2026-05-01-dimensions/14-derived-data.md` brainstorm. This document narrows the dimension's full scope to a **thin vertical slice** suitable for a single implementation increment (~2-3 weeks). It establishes the architectural contract end-to-end so later increments (cache-tier backends, built-in derivers, materialized views) layer on without rework.

## Goal

Ship a `withDerivation` strategy in `@noy-db/hub` that lets a vault declare *deterministic data derivations* of one or more typed outputs from a source record, with eager or lazy lifecycle, automatic invalidation on source change, and atomic rollback inside `withTransactions`. The outputs route to existing stores via existing collections; no new storage backends in v1.

## Success criteria (acceptance)

- A vault can register a derivation: source collection → multiple typed outputs (records of different collections).
- Writing to the source triggers derivation in eager mode (synchronous inside the write transaction) or lazy mode (deferred to first read).
- Updating the source invalidates derived records and re-derives (eager) or marks stale (lazy).
- A derivation that produces 3 outputs may have 1 fail; default semantics report the failure but commit the other 2; strict mode rolls back the whole transaction including the source write.
- Cycle detection at registration time refuses circular derivation graphs.
- All derivations preserve zero-knowledge: outputs are encrypted with the same DEK as the source by default; the derivation function runs *after DEK unwrap, on plaintext*.
- Conformance tests pass on `to-memory` and `to-file` stores.

## v1 SCOPE — what's in

| Feature | In v1 | Notes |
|---|:---:|---|
| `withDerivation({ source, outputs, derive, lifecycle })` factory | ✓ | The core API |
| Multi-output dispatch (single `derive` returns map of named outputs) | ✓ | The architectural novelty |
| Eager lifecycle (derive on source-write) | ✓ | Synchronous inside write transaction |
| Lazy lifecycle (derive on first stale read) | ✓ | Mark stale on source-change; derive on read |
| Source-change cascade (write to source → derive/invalidate dependents) | ✓ | Bounded depth (default 5) |
| Cycle detection at registration | ✓ | Refuse strategy registration if graph is cyclic |
| Strict mode rollback (`strict: true` rolls back source write if any output fails) | ✓ | Composes with `withTransactions` |
| Per-output partial-failure isolation (default, non-strict) | ✓ | Failed outputs marked with retry metadata |
| `_derivedFrom` envelope metadata (source ref + version + timestamp) | ✓ | Enables stale detection at read time |
| Same-DEK output encryption (zero-knowledge preserved) | ✓ | Default; separate-DEK is v2 |
| Manual `vault.deriveAll(collectionName)` re-derive primitive | ✓ | Bulk recomputation |
| Conformance test pack | ✓ | Vitest suite covering the criteria above |
| Documentation (`docs/subsystems/derivations.md`) | ✓ | Subsystem doc + recipe in showcase |

## v1 SCOPE — what's deferred

| Feature | Deferred to | Why |
|---|---|---|
| Cache-tier backends (`to-cache-*`) | v1.5 | Adds storage-backend work; not needed to validate the primitive |
| Built-in derivers (`@noy-db/derivers-pdf`, `-image`, etc.) | v2 | User-supplied `derive` is sufficient for v1 |
| `withMaterializedView` (collection-level query derivation) | v2 | Different shape (query → result), separate spec |
| Scheduled / cron-style refresh | v2 | Pairs with hooks/triggers (Dim 11), separate primitive |
| Non-deterministic derivations with persistence | v3 | Adds rebuild-on-miss vs. force-persist branching |
| External / sandboxed derivation runtimes (Cloudflare Workers, Deno isolates) | v3 | Adds wire-protocol + auth surface; separate spec |
| Public CDN derivations (`public: true`) | v3 | Privacy-tier ACL gate needs design (couples to Dim 02) |
| Streaming materialized views (over Dim 12 streams) | v3 | Pairs with Dim 12 stream primitive's own v1 |
| `withDerivation` + lazy-mode (v0.22 index sidecar) interaction | v3 | Lazy-mode index work in flight; address after both stabilise |

## Architecture

### Layers

```
┌─────────────────────────────────────────────────────────────┐
│ Application                                                  │
│   vault.collection('pdfs').put(record)                       │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Collection.put — existing entrypoint                        │
│   1. Permission check                                        │
│   2. Encryption (existing path)                              │
│   3. Store.put (existing)                                    │
│   4. **DerivationRegistry.onSourceWrite** ← NEW              │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ DerivationRegistry — NEW (vault-internal singleton)          │
│   - Holds strategy graph (source → outputs[])                │
│   - Cycle detection at registration                          │
│   - onSourceWrite(source, record): dispatch eager / mark stale  │
│   - resolveStale(collection, id): on-demand derive (lazy)    │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ DerivationExecutor — NEW                                     │
│   - Runs `derive(source)` after DEK unwrap                   │
│   - Validates output shape against output spec               │
│   - Encrypts each output (existing path) and writes via      │
│     Collection.put (existing) — outputs are normal records   │
│   - Per-output success/failure capture; rollback hook for    │
│     strict mode inside withTransactions                      │
└─────────────────────────────────────────────────────────────┘
```

### Key invariants

- **Zero-knowledge preserved.** Derivation runs after DEK unwrap, *inside* the encrypted boundary. Outputs are encrypted with the same DEK before reaching any store.
- **No new wire format.** Derived records use the existing envelope (`_noydb`, `_v`, `_ts`, `_iv`, `_data`) plus a single new metadata field `_derivedFrom: { source: 'pdfs', sourceId: 'abc', sourceVersion: 3, derivedAt: 'ts' }`. The field is in the encrypted payload (`_data`), not unencrypted metadata, so the storage backend cannot infer derivation graph from listing.
- **No new store interface.** Outputs route through existing stores via existing collections. The only registry-side knowledge is "which outputs go to which collections."
- **Atomic with `withTransactions`.** A single `Collection.put` that triggers eager derivation runs all dependent writes inside the same transaction. `strict: true` mode aborts the whole transaction on any output failure.

### Type surface

```ts
// Registration
interface DerivationStrategy<TSource, TOutputs extends Record<string, unknown>> {
  source: string  // collection name
  deterministic: true  // v1: only deterministic supported
  outputs: { [K in keyof TOutputs]: OutputSpec }
  derive: (source: TSource) => Promise<TOutputs> | TOutputs
  lifecycle: 'eager' | 'lazy'
  strict?: boolean  // default false
}

interface OutputSpec {
  shape: 'record'  // v1: only record outputs (blob/stream/embedding deferred)
  collection: string
  // store: deferred to v1.5 — outputs use the same vault store as the source
  // dek: 'shared' | 'separate' deferred to v2
}

// Returned by withDerivation()
interface DerivationStrategyHandle {
  __noydb_strategy: 'derivation'
  spec: DerivationStrategy<unknown, Record<string, unknown>>
}

// Vault method (added)
declare module '@noy-db/hub' {
  interface Vault {
    deriveAll(collection: string): Promise<{ derived: number; failed: number }>
  }
}
```

### `_derivedFrom` envelope metadata

```ts
// Added to the encrypted payload (NOT unencrypted metadata)
interface DerivedFromMeta {
  source: string         // source collection name
  sourceId: string       // source record id
  sourceVersion: number  // source's _v at derivation time
  derivedAt: string      // ISO timestamp
  strategyHash: string   // SHA-256 of (source + outputs map keys + derive function source)
                         // changes when the strategy changes → forces re-derive
}
```

The `strategyHash` is the v1 mechanism for detecting strategy drift: if the user changes the `derive` function or adds/removes outputs, existing derived records have a stale strategy hash and `vault.deriveAll()` will recompute them. This is the migration path for strategy evolution.

## Components

### New components

| Component | File | Responsibility |
|---|---|---|
| `withDerivation()` factory | `packages/hub/src/derivations/with-derivation.ts` | API surface; returns `DerivationStrategyHandle` |
| `DerivationRegistry` | `packages/hub/src/derivations/registry.ts` | Strategy graph + cycle detection + dispatch |
| `DerivationExecutor` | `packages/hub/src/derivations/executor.ts` | Run derive, validate outputs, write through Collection.put, partial-failure capture |
| `_derivedFrom` envelope ext | `packages/hub/src/envelope.ts` (modify) | New optional metadata field inside `_data` |
| `vault.deriveAll(name)` method | `packages/hub/src/vault.ts` (modify) | Bulk re-derive entrypoint |
| `withDerivation` showcase | `showcases/src/70-with-derivation.showcase.test.ts` | End-to-end: PDF source → metadata + text outputs |
| Subsystem doc | `docs/subsystems/derivations.md` | Reader-facing doc + zero-knowledge boundary explanation |
| `features.yaml` entry | `features.yaml` (modify) | New `derivations` section + showcase reference |

### Modified components

- `Collection.put` — adds `DerivationRegistry.onSourceWrite` hook after the store-level write succeeds
- `Collection.get` — adds optional stale-check + on-read derive path for lazy lifecycle
- `runTransaction` (in `withTransactions`) — accepts derivation operations as part of the transaction set; rolls back via existing revert pass
- `Vault` initialisation — registers strategies, validates the strategy graph (cycle detection)

## Data flow

### Eager source-write

```
Caller: vault.collection('pdfs').put({ id: 'abc', body: pdfBytes, ... })
  │
  ▼
Collection.put(pdfs, abc)
  │  ┌─ permission check (existing)
  │  ├─ encrypt envelope (existing)
  │  └─ store.put (existing)
  │
  ▼
DerivationRegistry.onSourceWrite('pdfs', { id: 'abc', record })
  │
  ▼ (inside same transaction if withTransactions is active)
DerivationExecutor.run(strategy, source)
  │  ┌─ DEK unwrap (existing path) — get plaintext source
  │  ├─ run derive(source) → { metadata, text }
  │  ├─ for each output: encrypt + Collection.put
  │  │   - vault.collection('pdf-metadata').put({ ...metadata, _derivedFrom: {...} })
  │  │   - vault.collection('pdf-text').put({ ...text, _derivedFrom: {...} })
  │  └─ capture per-output success/failure
  │
  ▼
strict mode? all-or-nothing rollback : commit partial success
```

### Lazy source-write

```
Source.put → DerivationRegistry marks all dependent records stale
  (sets a small in-memory bit + writes a "_stale" record in a meta collection)

Reader: vault.collection('pdf-text').get('abc')
  │
  ▼
Collection.get
  ├─ check stale bit → if stale, run DerivationExecutor before returning
  └─ return up-to-date derived record
```

### Source-change invalidation

```
Source.put (overwrite existing record id)
  │
  ▼
DerivationRegistry.onSourceWrite
  │  ┌─ eager: re-run derive, overwrite all outputs
  │  └─ lazy: mark dependent ids stale
```

## Error handling

| Failure | Behavior |
|---|---|
| `derive` throws | Strict: rollback transaction; non-strict: log per-output failure, continue |
| Single output fails to encrypt/write | Strict: rollback all outputs (and source); non-strict: that output marked failed, others succeed |
| Cycle detected at registration | Throw `DerivationCycleError` at vault init — refuse to open vault |
| Lazy stale-bit corruption (e.g., partial write of stale meta) | Re-derive on next read (idempotent) |
| Cascade depth exceeded (default 5) | Throw `DerivationDepthError`; user can override via `lifecycle: { maxDepth: N }` |
| Output collection not declared in vault | Throw `DerivationOutputUnknownError` at registration |
| Output writes encrypt with mismatched DEK | Should not happen (defaults to shared DEK); throw if attempted in v1 |

## Testing strategy

### Unit tests

- `DerivationRegistry` — strategy registration; cycle detection (self-loop, A→B→A, A→B→C→A); duplicate-strategy refusal
- `DerivationExecutor` — single output success; multi-output partial failure; strict mode rollback; cascade depth bound
- `_derivedFrom` envelope — strategyHash computation determinism; serialization round-trip
- Conformance suite — runs against `to-memory` and `to-file`

### Integration tests

- PDF derivation showcase — single source, two typed outputs, eager mode, end-to-end with real `to-file` store
- Source-change invalidation — write source, read stale derivative, verify re-derived correctly
- `withDerivation` + `withTransactions` interaction — strict-mode rollback verified across both
- `vault.deriveAll('pdf-metadata')` — bulk recompute after strategy change

### Security tests

- Output records are encrypted with the same DEK as the source (verify ciphertext equivalence-class)
- `_derivedFrom` lives inside `_data`, not in unencrypted envelope fields (verify storage-side ciphertext analysis cannot recover graph)
- Strategy registration with malicious-input cycle gracefully fails (no DoS)

## Backward compatibility

- Existing vaults without any derivation strategies are unaffected (`DerivationRegistry` is empty no-op)
- Existing `Collection.put` behavior is unchanged when no derivation depends on the collection
- `_derivedFrom` is an optional payload field; absent on records that aren't derived
- No envelope-format version bump — `_derivedFrom` lives inside `_data` payload, opaque to envelope versioning

## Open implementation questions (resolve during writing-plans)

These are punted from the brainstorm to the implementation-plan phase:

1. **Lazy stale-tracking persistence.** Stale bits are easy in-memory but lost on vault close. Persist as a hidden meta collection (`_stale_<source>`) or recompute lazily on every read until a derivation is observed?
2. **`strategyHash` storage.** Compute on every read for stale check, or cache in vault metadata? (Hashing the derive function source is O(function-size) on every check — small but non-zero.)
3. **Output type validation at runtime.** v1 trusts the `derive` function to return the declared output shapes. Should we add Zod/Valibot-style runtime checks per output, or document trust-the-deriver and defer to v2?
4. **`deriveAll` concurrency.** Bulk recompute can fan out to thousands of records. Sequential, parallel-with-cap, or batched-by-source-version?
5. **Vault-init failure recovery.** If cycle detection or another registration error throws, vault open fails — is there a partial-init-and-warn fallback for migration scenarios, or always-fail-fast?

## Cross-references

- Brainstorm artefact: [`2026-05-01-dimensions/14-derived-data.md`](./2026-05-01-dimensions/14-derived-data.md) — full dimension scope
- Related dimensions: 07 (`withComputedFields` is the in-record narrow case), 13 (embeddings reframe as `withDerivation` shorthand once 14 ships), 12 (streaming materialized views deferred to v3)
- `features.yaml` — new `derivations` section (must register before v1 PR merges)
- Spec anchor: `SUBSYSTEMS.md#derivations` — new section to add

## Sequencing for implementation

The implementation plan (writing-plans output) should sequence roughly:

1. **Envelope extension** — `_derivedFrom` payload field + tests (smallest first piece, no API surface)
2. **DerivationRegistry skeleton** — strategy registration + cycle detection (no execution yet)
3. **DerivationExecutor** — eager-mode execution with single output, against `to-memory`
4. **Multi-output dispatch** — extend executor + tests
5. **Lazy-mode invalidation + stale tracking** — adds the second lifecycle
6. **`Collection.put` / `Collection.get` integration** — hook into the existing entry points
7. **`withTransactions` strict-mode rollback** — atomic semantics
8. **`vault.deriveAll`** — bulk recompute primitive
9. **Conformance suite** — porting to `to-file`
10. **Showcase + recipe + subsystem doc + `features.yaml` entry** — documentation and verification

Each step should produce a green test before the next begins.
