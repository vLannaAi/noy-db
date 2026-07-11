# Field features — the Via port

The noy-db kernel is a pure encrypted document store: documents, envelopes, a query executor — and **one port**. Every capability a field can have — indexed, a reference, computed, money, translated, classified, a blob — is a **via-feature**: a declaration on the field that plugs behavior into one unified pipeline. You start with plain JSON and adopt one feature at a time; each is a separately tree-shaken chunk; anything you don't declare doesn't exist in your bundle. Underneath, every feature's promises — freshness, referential integrity, security posture, erasure — are enforced through one dependency graph and one mutation choke point, so a stale rollup, a dangling reference, a leaked derivative, or an unforgotten residue is a *kernel-refused state*, not a bug found in production.

**The architecture in one sentence:** *via-features declare, services provide engines, the kernel runs pipelines, the graph connects them.*

```ts
// rung 0 — kernel only: plain encrypted documents. No features, no chunks.
title:    {}

// each rung is one declaration + one tree-shaken chunk:
number:   via(indexed())                                   // fast lookup            (phase D)
customer: via(ref('customers', { onDelete: 'restrict' }))  // FK integrity           (phase D)
summary:  via(searchable())                                // full-text              (phase D)
subtotal: via(money({ currency: 'EUR', scale: 2 }))         // exact arithmetic       (phase A)
label:    via(i18nText({ languages: ['en', 'th'], required: 'all' }))  // locale fills + Label (phase A)
total:    via(computed(r => r.subtotal * (1 + r.vat), { deps: ['subtotal','vat'] }),
              money({ currency: 'EUR' }))                   // derived + stacked      (phase C + A)
iban:     via(classified())                                // sealed at rest         (phase B)
contract: via(blob())                                      // externalized binary    (phase B)
```

> Illustrative — the phase A entries (`money`, `i18nText`) are shipped and runnable
> as spelled above (see the `via()` composer section below for the full
> collection-option context). Phase B's `classified`/`blob` features are ALSO
> shipped, but not yet through the `via()` composer shown here — declare them
> via their own sugar keys instead, `classifiedFields`/`blobFields` (see
> [`docs/subsystems/via-classified.md`](via-classified.md) /
> [`docs/subsystems/via-blob.md`](via-blob.md)); `via(classified())` /
> `via(blob())` as spelled above remain unrunnable until the composer grows
> those brands. The phase C–D entries (`indexed`, `ref`, `searchable`,
> `computed`) are unshipped design sketches, not yet runnable.

## The grammar (the naming system this arc completes)

noy-db speaks **prepositions**; the grain is the tier. `for` and `with` are JS reserved words — `via` is legal, pipeline-true ("the value passes via the seal, via the formula, via the index"), the sibling of `by-` ("by way of"), and security-honest where `like` would read as simulation.

| Prefix | Tier | Reads as | Examples |
|---|---|---|---|
| **2-letter** `to- in- on- as- by- at-` | family packages (where noy-db meets the world) | data goes *to*, runs *in*, unlock *on*, export *as*, sync *by*, sealed *at* | `to-postgres`, `in-react`, `as-csv` |
| **3-letter** `via-` | **field grain** (how a value flows) | the value passes *via* these features | `via(money({ currency: 'EUR' }), indexed())` |
| **4-letter** `with-` | vault grain (what the vault is equipped with) | the vault comes *with* these services | `withSync()`, `withPeriods()` |

**Collection = the meeting point, not a tier.** Everything collection-level decomposes: per-collection *configuration* of `with-` services (conflictPolicy, crdt, lazy), kernel-fixed validation (schema), aggregated field declarations (sugar for per-field `via(...)`), and collection *topology* already defined by `with-` factories. No third preposition.

## The `via()` composer

Fields declare their features using `via(...)`, the unified field-feature declaration surface. `viaFields` is a **sibling** collection option next to `schema` — never a key inside `schema` — and holds one `via(...)` per declared field:

```ts
const invoices = vault.collection<Invoice>('invoices', {
  schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
  viaFields: {
    total: via(money({ currency: 'EUR', scale: 2 })),
  },
})
```

A field can stack more than one descriptor in a single `via(...)` call, and different fields can each declare their own feature(s) in the same `viaFields` map:

```ts
const invoices = vault.collection<Mixed>('invoices', {
  schema: z.object({
    id: z.string(),
    total: z.union([z.number(), z.string()]),
    note: z.record(z.string(), z.string()),
  }),
  viaFields: {
    total: via(money({ currency: 'EUR', scale: 2 })),
    note: via(i18nText({ languages: ['en', 'th'], required: 'all' })),
  },
})
```

### Sugar equivalence — existing spellings preserved

The feature-specific sugar keys (`moneyFields`, `i18nFields`, `dictKeyFields`) compile to the same internal bindings as `viaFields`, with identical stored envelopes and `describe()` output — verified byte-for-byte in `packages/hub/__tests__/via/compose.test.ts`:

```ts
// Sugar spelling (still works, identical internals):
const sugarCol = vault.collection<Invoice>('invoices', {
  schema,
  moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
})

// via() spelling (canonical):
const viaCol = vault.collection<Invoice>('invoices', {
  schema,
  viaFields: { total: via(money({ currency: 'EUR', scale: 2 })) },
})
```

Both produce the same declarations, byte-identical persisted records, and identical introspection (`describe()` output). Existing code using a sugar key continues without change; new code can use the composable `via()`/`viaFields` surface instead. Declaring the **same field** under both a sugar key and `viaFields` throws `ValidationError` naming the field — one declaration site per field.

## The phased write & read pipeline

All field features run in a **kernel-orchestrated phased pipeline**, pinned by the kernel to ensure cross-feature ordering and dependency correctness:

```
WRITE:  derive (C) → normalize (A) → validate (kernel) → encode (B) → store
READ:   load → decode (B) → present (A)
```

For each phase, features run in **declared stack order** (the order they appear in `via(...)`). The runner lives in the kernel; collection.ts calls it at the existing write/read call sites, replacing today's hand-wired money/i18n branches. Zero-via fields skip the runner entirely (identity fast path — no regression for plain documents).

The **feature stack order** is deterministic and pinned in one place (`compileViaBindings`). Today `collection.describe()` carries each feature's `describeFragment` contribution; surfacing the full per-field via-stack, phase order, declared dependencies, and staleness state is planned for phase C (the dependency graph makes those inspectable).

## Architecture guards & enforcement

The kernel enforces two new **architecture rules** (checked by `pnpm check:architecture` at build time — `via-layering` and `via-enclave-isolation`):

1. **`kernel` imports nothing from `shape/via-*`** — all via-features are in the `shape/` layer; the kernel holds only the port contract and runner. One frozen grandfather: `kernel/query/join.ts` imports i18n's `applyI18nLocale` from `shape/via-i18n/core.js` for join-layer presentation (sync, i18n-text-only resolution of a joined right-side field) — issue #626 tracks converging it onto the Via seam instead.
2. **`shape/via-*` never imports `kernel/enclave/`** — this rule bans importing the enclave, not "crypto.subtle directly": crypto should reach a feature only through a scoped context (`ViaCryptoCtx`). Phase B built `ViaCryptoCtx` (the kernel's `sealedSlots`/`reservedEnvelopes` capability factories, `kernel/enclave/record-keys/sealed-slots.ts`) and used it to reroute `shape/via-i18n/dictionary.ts`'s `DictionaryHandle` off its former direct `kernel/enclave/index.js` import (the one grandfather this rule used to carry, predating #623) onto `reservedEnvelopes('_dict_')` — **the allowlist is now empty** and every `shape/via-*/**` file, including the new `via-classified`/`via-blob`, is enclave-clean by construction — statically; the rule only bans a static `import ... from`. The reveal/verify engines reach the enclave through the Check-13-allowlisted (`enclave-classify-index-only`) dynamic strategy seam in `shape/via-classified/active.ts` (`await import('../../kernel/enclave/classify/...')`), which Check 15 does not see.

`ViaCryptoCtx` is kernel-internal machinery for feature *authors* (a `ViaBinding`'s `encodeAtRest`/`decodeAtRest`/`erase` hooks receive it as a parameter — see `kernel/via.ts`) — not something a collection consumer calls directly. `sealedSlots` seals/unseals individual fields into their own `iv:data` slot under per-record key material (the mechanism `via-classified` seals recoverable fields with); `reservedEnvelopes(prefix)` is a whole-envelope encrypt/decrypt door scoped to collection names under a declared prefix, for reserved kernel-managed collections like `_dict_*` (see `packages/hub/__tests__/via/crypto-ctx.test.ts`).

## Implementation phases

The via-port lands in five phases, each with its own feature set, integration depth, and cross-repo governance:

| Phase | What | Status | Issues |
|---|---|---|---|
| **A** | Core port (contract, registry, pipeline runner), `via-money`, `via-i18n` (sugar compatibility) | Landed on `feat/623-via-port`, unreleased | #623 (milestone #28) |
| **B** | Security features: `via-classified`, `via-blob`; posture enforcement (query/export/forget); `ViaCryptoCtx` (`sealedSlots`/`reservedEnvelopes`) | Landed on `feat/629-via-phase-b`, unreleased | #629 (milestone #28) |
| **C** | Formula & graph: `via-computed` (virtual mode), dependency engine, choke-point dispatch — fixes #621 and #622 structurally | Design | issue TBD |
| **D** | Lookup layer: `via-ref` (FK deps), `via-indexed`, `via-searchable` — index/search maintenance onto the choke point | Design | issue TBD |
| **E** | External SPI — publish the contract; plugin sandboxing; posture non-forgeability | Deferred | TBD |

Each phase is self-contained; work in earlier phases does not block later ones. Phase A ships with zero via-features in the kernel — all behavior lives in the features themselves, tree-shaken away if unused.

Phase A's whole-branch review filed three follow-ups rather than blocking the phase — all **phase-A review follow-ups**, not new phases: **#625** (restore the index-accelerated `==`/`in` fast path for fixed-mode money `where()` clauses — the `indexProbe` hook), **#626** (converge `kernel/query/join.ts`'s join-layer i18n resolution onto the Via seam — see the grandfather note above), and **#627** (a `viaFields`-declared money field skips the late-attach reconcile when a collection is constructed twice before the declaration — the late-attach gap).

### Phase B — security features + posture enforcement

Phase B retrofits the two remaining security-sensitive field kinds — classified fields (`shape/via-classified/`) and blobs (`shape/via-blob/`) — as via-features, and makes every binding's declared `ViaPosture` (`encryptedAtRest`/`queryable`/`exportable`/`forgettable`) an *enforced* contract instead of documentation: the query DSL refuses a `queryable: 'none'` field (`FieldNotQueryableError`), `Vault.exportStream()`/`exportJSON()` deliberately redact a `exportable: false` field to the literal string `'[sealed]'`, and `vault.forget()` consults `forgettable` and folds each sealed-posture binding's `erase()` hook into its erasure report. See [`docs/subsystems/via-classified.md`](via-classified.md) and [`docs/subsystems/via-blob.md`](via-blob.md) for the per-feature detail — two things worth knowing before reading either:

- **`via-blob` is deliberately thin.** Blob content (chunked AEAD, per-blob key lifecycle) is real cryptographic engine work that the `via-enclave-isolation` rule forbids under `shape/via-*` — so unlike `via-classified`, `via-blob`'s binding carries only declaration + posture + `describeFragment` + an `erase` hook; the content-crypto machinery stays service-side at `with-shape/blobs/` (unchanged, pre-dating the via port). `via-blob` declares no `encodeAtRest`/`decodeAtRest` hooks and never touches `ViaCryptoCtx`.
- **Two pieces of erase-hook wiring are real, tested, and stay production-dormant on purpose.** `via-classified`'s `erase()` hook is live for `_sealed`-slot shred/residue classification (`vault.forget()` routes through it whenever a `classifiedFields` binding is compiled in — see `forget-classified-erase.test.ts`), but its *sealed-CEK prefix-purge* participation (`purgeSealedCekEnvelopes`) is never wired in, and `via-blob`'s `erase()` hook (`purgeBlobsForRecord`) is never wired in at all. Both are proven (by the pre-existing `forget-sealed-erasure.test.ts`/`per-blob-cek.test.ts` suites) to be **vault-level operations, unconditional on any given collection declaring `classifiedFields`/`blobFields`** — routing them exclusively through a per-collection via binding would silently stop shredding for undeclared collections. `vault.forget()` keeps calling both directly (the sealed-CEK `_sealed_cek/*` prefix-delete, and `collection.blob(id).shredAllForRecord()`); the hooks themselves are unit-tested and wireable by a future, collection-scoping-aware caller. Making that scoping decision is a future product call, not a phase-B gap.

## See also

- [`docs/superpowers/specs/2026-07-10-via-port-design.md`](../superpowers/specs/2026-07-10-via-port-design.md) — full phase A design spec
- [`docs/superpowers/specs/2026-07-11-via-phase-b-design.md`](../superpowers/specs/2026-07-11-via-phase-b-design.md) — full phase B design spec
- [`docs/subsystems/via-money.md`](via-money.md) — money feature docs
- [`docs/subsystems/via-i18n.md`](via-i18n.md) — i18n feature docs
- [`docs/subsystems/via-classified.md`](via-classified.md) — classified feature docs
- [`docs/subsystems/via-blob.md`](via-blob.md) — blob feature docs
- `packages/hub/src/kernel/via.ts` — the port contract and kernel runner (incl. `ViaCryptoCtx`, `ViaEraseCtx`/`ViaEraseReport`)
- `packages/hub/src/kernel/via-pipeline.ts` — the phased runner (incl. `postureFor`, `redactForExport`, `eraseSealed`)
- `packages/hub/src/kernel/via-compose.ts` — the `via()` composer + sugar/`viaFields` merge
- `packages/hub/src/kernel/enclave/record-keys/sealed-slots.ts` — `ViaCryptoCtx`'s kernel-side capability factories
- `packages/hub/src/shape/via-money/` — phase A: money binding
- `packages/hub/src/shape/via-i18n/` — phase A: i18n binding
- `packages/hub/src/shape/via-classified/` — phase B: classified binding
- `packages/hub/src/shape/via-blob/` — phase B: blob binding
