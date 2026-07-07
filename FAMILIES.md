# NOYDB Families & Services — the classification guide

> How to decide **where a package or capability belongs**: which preposition family, which
> hub service cluster, a port, or the prefix-less top level. Companion to
> [`SERVICES.md`](SERVICES.md) (the service catalog itself) and the port table in
> [`docs/superpowers/specs/2026-07-01-noydb-architecture-lexicon.md`](docs/superpowers/specs/2026-07-01-noydb-architecture-lexicon.md#addendum-ports-2026-07-02).
> Read this when adding, renaming, or questioning a package's home.

## The two axes

NOYDB's catalog is organized along **two independent axes** that are easy to conflate:

1. **Package families** (`to-` / `on-` / `at-` / `in-` / `by-` / `as-`) — separate npm packages,
   classified by their **relationship to the trust boundary**, each binding exactly one frozen
   port subpath (`@noy-db/hub/to`, `/on`, …). The preposition is written from the
   **vault owner's perspective**: data goes *to* a backend, the owner gets *on* via a method,
   exports *as* a format, the hub is adapted *into* a host runtime, sessions sync *by* a
   transport, slices are sealed *at* a host you control.
2. **Hub services** (`with-*` clusters inside `packages/hub/src/`) — opt-in capabilities of the
   vault itself, living **inside the trust boundary**, gated by `with*()` strategy factories,
   tree-shaken when unused, governed by the [`SERVICES.md`](SERVICES.md) checklist and the
   bundle-size gate.

A package family answers *"who is this code to the vault?"*. A service answers *"what can the
vault itself do?"*. Nothing is ever both.

## The family table (refined glosses)

| Prefix | Reads as | Precise gloss | Sees plaintext? | May hold keys? | May write vault state? |
|---|---|---|---|---|---|
| `to-` | data goes **to** a backend | a **medium that persists ciphertext envelopes** — a *where*, never a cache tier | No — ciphertext only | No | Envelopes only, as told |
| `on-` | get **on** via this method | unlock / auth primitive | No | Handles unlock material, never DEKs | No |
| `at-` | sealed **at** a trusted host | sealing-key provider (the one non-ZK family, by design) | Scoped slice | Scoped, on your infra | No |
| `in-` | runs **in** a host | **adapts the hub's existing public surface into a host runtime or protocol** (React render loop, TanStack cache lifecycle, an LLM tool-calling loop, REST, Yjs) | As an authorized consumer (like app code) | No | Via public API only |
| `by-` | sync **by** way of | session-share transport | No | No | No |
| `as-` | export **as** a format | **pure read-side transform**: vault handle in → formatted bytes out | Plaintext (post-decrypt, by design) | **Never** | **Never** |

Two glosses above deliberately sharpen the older table:

- **`to-` is a *where*, not a *how fast*.** `to-memory` is not a cache — it is RAM used as a
  ciphertext persistence backend, holding encrypted envelopes plus every reserved namespace
  (`_schemas`, `_history`, `_ftindex`, tombstones…). The kernel's internal record cache is the
  opposite object on every axis: plaintext, per-collection, inside the trust boundary, not
  pluggable, not a family member. They coexist because they answer different questions.
  `to-memory` additionally serves as the reference store: the conformance oracle every other
  `to-*` must match, and the substrate that lets all of CI run with no real cloud service.
- **`in-` means "into a host", not "UI framework".** `in-ai` (LLM function-calling adapter),
  `in-rest`, and `in-yjs` are full family members: each projects the hub's existing surface into
  a foreign runtime's idiom and is meaningless without that runtime. The test is *whose
  lifecycle does the code serve* — never the topic. `in-ai` sounds retrieval-flavored, but it
  computes no retrieval and persists no index; it emits ACL-scoped tool definitions and
  dispatches tool calls back through the public API. (Retrieval capability is `with-lookup`,
  inside the hub, where the encrypted index artifacts live.)

## Ports vs services vs combinators

Three store-flavored things exist and none duplicates another:

- **`src/port/to` (`@noy-db/hub/to`)** — the **contract door**: a behavior-free re-export barrel
  (the 6-method `NoydbStore`, envelope/op types, store errors). What a `to-*` package *binds*.
  Frozen; additive-only; every addition is surface the whole family supports forever.
- **`to-*` packages** — the **adapters** that implement the contract.
- **`src/with-store`** — a **service of combinators over the contract**: `routeStore`
  (multiplex by collection/size/age) and store middleware (`withRetry`, `withCache`,
  `withCircuitBreaker`, …), each mapping `NoydbStore → NoydbStore`, envelope-in/envelope-out.
  Its audience is application authors composing stores; a store author never touches it.

The rule: **contract doors stay behavior-free; anything that *does* something is a service.**
The moment routing logic lived in the port, every store adapter would inherit version coupling
to it. (Same shape one level up: `port/as` exports `diffVault`/`writePod`/`Vault` — the
primitives an exporter closes over — while the exporters themselves are separate packages.)

## The classification rules

Apply in order; the first rule that bites decides.

**R1 — Classify by the *worst* thing the code must do, not the most recognizable.**
Attestation issuance contains a conversion (record → QR credential), a signature, and a ledger
write. The conversion is the recognizable part; the key custody is the classifying part.
Anything that must touch `getDEK`, mint or hold key material, or write vault state is a
`with-*` service, no matter how export-shaped its output looks.

**R2 — Capability lives in the hub; protocol projection lives in `in-*`.**
If the code *adds an ability the vault didn't have* (retrieval, history, attestation signing),
it is a service inside the trust boundary. If it *re-expresses an existing ability in someone
else's idiom* (hooks, query caches, tool definitions, REST routes), it is an `in-*` binding —
even when, like `in-ai`, it has no external dependency and only the role test catches it.

**R3 — A family invariant outranks a single package's convenience.**
`as-attestation` would "work" only if the `as-` port grew `getDEK` access and store writes —
re-classifying all exporters from "sees plaintext, holds nothing, writes nothing" (one-sentence
auditability) to "may hold keys". One package never buys that. Where a capability has an
export-shaped tail, split it: the key-touching part is a service; a *downstream* pure formatter
over its already-persisted output (e.g. a printable-credential exporter reading
`_attestations` through the vault handle) is a legitimate `as-*` citizen.

**R4 — Counterparty features ship as two packages.**
When the primary user of some code is *not the vault owner* (a relying party verifying a QR
credential), no owner-centric preposition fits — and forcing one would break the grammar's
promise. The shape is: **capability inside** (a `with-*` service holding the keys) plus a
**zero-dependency primitive outside** (a prefix-less package the counterparty consumes without
installing the hub or holding anything). Attestation is the type specimen: `withAttestation()`
in `with-audit/attestation` + pure `@noy-db/attestation` (verify, decode, revocation-list
checks, offline).

**R5 — No prefix means: holds no vault, and serves someone other than (or larger than) a
single vault owner.** The prefix-less top level is a meaningful third tier, not a junk drawer:
`hub` (the core), `lobby` (control-plane stub; real one in klum-db), `cli`, `create-noy-db`
(tooling), `attestation` (counterparty verifier). If counterparty packages multiply (receipts,
proofs, shared-view credentials), a dedicated family (e.g. `for-*`, "verifiable *for* a
counterparty") may earn its place; with n=1 it does not.

## Case studies (how the rules were derived)

| Question | Answer | Rule |
|---|---|---|
| Why does `to-memory` exist when the kernel has a cache? | Different layers: ciphertext persistence backend vs plaintext read acceleration; also the conformance oracle and CI substrate | table gloss 1 |
| Why both `port/to` and `with-store`? | Contract door (behavior-free, frozen) vs combinators over it (routing, middleware) | R3's ancestor: doors stay behavior-free |
| Why are `in-ai` / `in-tanstack-query` bindings, not lookup services? | They add no capability; they project existing surface into a host runtime (TanStack's cache lifecycle; the LLM tool-calling loop). `with-lookup` holds the encrypted indexes and must live inside | R1, R2 |
| Why isn't attestation `as-attestation`? | Issuance mints/holds an Ed25519 signer under `getDEK`, appends to `_attestations`, and manages revocation — three things the `as-` port must never carry. The pure conversion tail already lives outside as `@noy-db/attestation` | R1, R3, R4 |

## Known warts (accepted or queued)

- `with-store` is **root-barrel-only** (no `@noy-db/hub/with-store` subpath) while sibling
  services have subpaths — either give it one or document the rule for when a service doesn't
  get one.
- The flat `packages/` directory (~51 entries) clusters by family only alphabetically; a
  family-folder nesting (`packages/in/in-react`, …) is feasible and cheap because everything
  load-bearing keys off npm names, not paths — planned as its own arc (workspace glob,
  guard-discovery recursion, two CI paths).
- `in-` glosses in older docs read as "framework bindings", underselling `in-ai`/`in-rest`/
  `in-yjs`; this doc's gloss ("into a host runtime or protocol") is the corrected reading.
