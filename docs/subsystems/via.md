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
subtotal: via(money('EUR'))                                // exact arithmetic       (phase A)
label:    via(i18nText())                                  // locale fills + Label   (phase A)
total:    via(computed(r => r.subtotal * (1 + r.vat), { deps: ['subtotal','vat'] }),
              money('EUR'))                                // derived + stacked      (phase C + A)
iban:     via(classified())                                // sealed at rest         (phase B)
contract: via(blob())                                      // externalized binary    (phase B)
```

## The grammar (the naming system this arc completes)

noy-db speaks **prepositions**; the grain is the tier. `for` and `with` are JS reserved words — `via` is legal, pipeline-true ("the value passes via the seal, via the formula, via the index"), the sibling of `by-` ("by way of"), and security-honest where `like` would read as simulation.

| Prefix | Tier | Reads as | Examples |
|---|---|---|---|
| **2-letter** `to- in- on- as- by- at-` | family packages (where noy-db meets the world) | data goes *to*, runs *in*, unlock *on*, export *as*, sync *by*, sealed *at* | `to-postgres`, `in-react`, `as-csv` |
| **3-letter** `via-` | **field grain** (how a value flows) | the value passes *via* these features | `via(money('EUR'), indexed())` |
| **4-letter** `with-` | vault grain (what the vault is equipped with) | the vault comes *with* these services | `withSync()`, `withPeriods()` |

**Collection = the meeting point, not a tier.** Everything collection-level decomposes: per-collection *configuration* of `with-` services (conflictPolicy, crdt, lazy), kernel-fixed validation (schema), aggregated field declarations (sugar for per-field `via(...)`), and collection *topology* already defined by `with-` factories. No third preposition.

## The `via()` composer

Fields declare their features using `via(...)`, the unified field-feature declaration surface. Each feature is optional; the kernel degrades gracefully when none are declared (identity fast path — zero overhead):

```ts
collection<LineItem>({
  schema: {
    qty: z.number(),
    price: via(money('USD')),                         // money normalization + Formatted/Number virtuals
    label: via(i18nText({ dict: 'labels' })),        // i18n fill-missing + Label virtual
    customerId: via(ref('customers', { onDelete: 'restrict' })),  // FK integrity
    total: via(
      computed(r => r.qty * r.price.value, { deps: ['qty', 'price'] }),  // derived + validated
      money('USD')                                    // stacked features share one via() call
    ),
  }
})
```

### Sugar equivalence — existing spellings preserved

The older declarative surfaces compile to identical `via(...)` stacks, with identical stored envelopes and `describe()` output:

```ts
// Old spelling (still works, identical internals):
collection<LineItem>({
  moneyFields: { price: 'USD', total: 'USD' },
  i18nFields: { label: { dict: 'labels' } },
  computed: { total: r => r.qty * r.price.value },
  refs: { customerId: { collection: 'customers', onDelete: 'restrict' } }
})

// New spelling (canonical):
collection<LineItem>({
  schema: {
    price: via(money('USD')),
    label: via(i18nText({ dict: 'labels' })),
    customerId: via(ref('customers', { onDelete: 'restrict' })),
    total: via(computed(...), money('USD'))
  }
})
```

Both produce the same declarations, binary-identical persisted records, and identical introspection (`describe()` output). Existing code continues without change; new code uses the composable `via()` surface.

## The phased write & read pipeline

All field features run in a **kernel-orchestrated phased pipeline**, pinned by the kernel to ensure cross-feature ordering and dependency correctness:

```
WRITE:  derive (C) → normalize (A) → validate (kernel) → encode (B) → store
READ:   load → decode (B) → present (A)
```

For each phase, features run in **declared stack order** (the order they appear in `via(...)`). The runner lives in the kernel; collection.ts calls it at the existing write/read call sites, replacing today's hand-wired money/i18n branches. Zero-via fields skip the runner entirely (identity fast path — no regression for plain documents).

The **feature stack order** is printable and debuggable. `collection.describe()` and devtools show each field's via-stack, phase order, declared dependencies, and staleness state.

## Architecture guards & enforcement

The kernel enforces two new **architecture rules** (checked by `pnpm check:architecture` at build time):

1. **`kernel` imports nothing from `shape/via-*`** — all via-features are in the `shape/` layer; the kernel holds only the port contract and runner.
2. **`shape/via-*` never imports crypto.subtle directly** — crypto capability arrives through `ViaCryptoCtx`, a scoped, capability-limited context injected at encode/decode time. This boundary holds from day one so the eventual external SPI (phase E) is publication, not redesign.

Two documented **grandfathers** (existing hand-wired integrations that will be absorbed into the graph in phase C):
- `kernel/query/join.ts` — money-decode dispatch for join operand quantization (issue #626)
- `shape/via-i18n/policy.ts` + materialized-view i18n layer — the `mv` materialization policy for dictionary resolution (will be integrated into the phase C graph)

## Implementation phases

The via-port lands in five phases, each with its own feature set, integration depth, and cross-repo governance:

| Phase | What | Status | Issues |
|---|---|---|---|
| **A** | Core port (contract, registry, pipeline runner), `via-money`, `via-i18n` (sugar compatibility) | **SHIPPED** (0.3.0-pre.8) | #623 (milestone #28) |
| **B** | Security features: `via-classified`, `via-blob`; posture enforcement; async per-field | Design → Todo | #625 |
| **C** | Formula & graph: `via-computed` (virtual mode), dependency engine, choke-point dispatch (fixes #621, #622) | Design | #626 |
| **D** | Lookup layer: `via-ref` (FK deps), `via-indexed`, `via-searchable` — index/search maintenance onto choke point | Design | #627 |
| **E** | External SPI — publish the contract; plugin sandboxing; posture non-forgeability | Deferred | TBD |

Each phase is self-contained; work in earlier phases does not block later ones. Phase A ships with zero via-features in the kernel — all behavior lives in the features themselves, tree-shaken away if unused.

## See also

- [`docs/superpowers/specs/2026-07-10-via-port-design.md`](../superpowers/specs/2026-07-10-via-port-design.md) — full design spec
- [`docs/subsystems/via-money.md`](via-money.md) — money feature docs
- [`docs/subsystems/via-i18n.md`](via-i18n.md) — i18n feature docs
- `@noy-db/hub/kernel/via.ts` — the port contract and kernel runner
- `@noy-db/hub/shape/via-money` — phase A: money binding
- `@noy-db/hub/shape/via-i18n` — phase A: i18n binding
