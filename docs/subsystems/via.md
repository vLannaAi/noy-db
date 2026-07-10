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
> collection-option context). The phase B–D entries (`indexed`, `ref`,
> `searchable`, `computed`, `classified`, `blob`) are unshipped design sketches,
> not yet runnable.

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

The **feature stack order** is printable and debuggable. `collection.describe()` and devtools show each field's via-stack, phase order, declared dependencies, and staleness state.

## Architecture guards & enforcement

The kernel enforces two new **architecture rules** (checked by `pnpm check:architecture` at build time — `via-layering` and `via-enclave-isolation`):

1. **`kernel` imports nothing from `shape/via-*`** — all via-features are in the `shape/` layer; the kernel holds only the port contract and runner. One frozen grandfather: `kernel/query/join.ts` imports i18n's `applyI18nLocale` from `shape/via-i18n/core.js` for join-layer presentation (sync, i18n-text-only resolution of a joined right-side field) — issue #626 tracks converging it onto the Via seam instead.
2. **`shape/via-*` never imports `kernel/enclave/`** — this rule bans importing the enclave, not "crypto.subtle directly": crypto should reach a feature only through a scoped context (`ViaCryptoCtx`, phase B, milestone #28), never a direct enclave-barrel import. One frozen grandfather, predating #623: `shape/via-i18n/dictionary.ts` imports `kernel/enclave/index.js` for `DictionaryHandle`'s own crypto (encrypting/decrypting `_dict_*` entry envelopes) — phase B's `ViaCryptoCtx` will own rerouting it.

## Implementation phases

The via-port lands in five phases, each with its own feature set, integration depth, and cross-repo governance:

| Phase | What | Status | Issues |
|---|---|---|---|
| **A** | Core port (contract, registry, pipeline runner), `via-money`, `via-i18n` (sugar compatibility) | Landed on `feat/623-via-port`, unreleased | #623 (milestone #28) |
| **B** | Security features: `via-classified`, `via-blob`; posture enforcement; async per-field (`ViaCryptoCtx`) | Design → Todo | issue TBD |
| **C** | Formula & graph: `via-computed` (virtual mode), dependency engine, choke-point dispatch — fixes #621 and #622 structurally | Design | issue TBD |
| **D** | Lookup layer: `via-ref` (FK deps), `via-indexed`, `via-searchable` — index/search maintenance onto the choke point | Design | issue TBD |
| **E** | External SPI — publish the contract; plugin sandboxing; posture non-forgeability | Deferred | TBD |

Each phase is self-contained; work in earlier phases does not block later ones. Phase A ships with zero via-features in the kernel — all behavior lives in the features themselves, tree-shaken away if unused.

Phase A's whole-branch review filed three follow-ups rather than blocking the phase — all **phase-A review follow-ups**, not new phases: **#625** (restore the index-accelerated `==`/`in` fast path for fixed-mode money `where()` clauses — the `indexProbe` hook), **#626** (converge `kernel/query/join.ts`'s join-layer i18n resolution onto the Via seam — see the grandfather note above), and **#627** (a `viaFields`-declared money field skips the late-attach reconcile when a collection is constructed twice before the declaration — the late-attach gap).

## See also

- [`docs/superpowers/specs/2026-07-10-via-port-design.md`](../superpowers/specs/2026-07-10-via-port-design.md) — full design spec
- [`docs/subsystems/via-money.md`](via-money.md) — money feature docs
- [`docs/subsystems/via-i18n.md`](via-i18n.md) — i18n feature docs
- `packages/hub/src/kernel/via.ts` — the port contract and kernel runner
- `packages/hub/src/kernel/via-compose.ts` — the `via()` composer + sugar/`viaFields` merge
- `packages/hub/src/shape/via-money/` — phase A: money binding
- `packages/hub/src/shape/via-i18n/` — phase A: i18n binding
