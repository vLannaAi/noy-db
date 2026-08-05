# Architecture

The durable shape of `@noy-db/hub` and its satellites. This is the orientation
document: what is true, why it is true, and which of those truths are enforced
mechanically rather than by convention.

It deliberately carries no release history. What shipped when lives in each
package's `CHANGELOG.md`; what a feature *does* lives in the
[noy-db-docs](https://github.com/vLannaAi/noy-db-docs) site and its
`registry/features.yaml`; the deep per-subsystem engineering references live in
[`docs/subsystems/`](subsystems/).

> **On `design-history/…` references.** Comments in source and tests sometimes
> cite a design document by a path beginning `design-history/`. That directory
> does not exist. Until 2026-08-05 this repository carried ~270 brainstorm →
> spec → plan documents under `docs/superpowers/`; they described features that
> had already shipped, and their stale status headers had begun to contradict
> the code. They were removed, and the references rewritten to this marker. The
> name still identifies the document, and `git log` still has its contents — but
> treat any claim inside one as history, not as a statement about today.

---

## The one invariant

> **Encryption happens inside `@noy-db/hub` before any storage backend is called.**

AES-256-GCM, keys derived through PBKDF2-SHA256 (600K iterations) and unwrapped
via AES-KW, all through `crypto.subtle` — never an npm crypto library.

Everything else in this document is downstream of that sentence. It is what lets
any `to-*` backend be a dumb, untrusted ciphertext blob: a store that is
compromised, subpoenaed, or simply badly operated yields ciphertext and nothing
else.

Two consequences people trip over:

- **The query DSL runs inside the hub, after decryption.** A store never
  executes a query, never sees a predicate, and never sees a field name. Pushing
  a filter down to the backend would mean showing the backend plaintext.
- **`as-*` exporters are the deliberate exception.** They receive plaintext by
  definition — an export is plaintext leaving the trust boundary on purpose. They
  are the only satellite family that does.

The invariant is enforced at build time, not by review discipline. See
[`CI-GUARDS.md`](CI-GUARDS.md), check 4.

### Where the boundary is *not*

`at-*` sealing providers are the one non-zero-knowledge family. A host you
control can decrypt the scoped slice it unseals — that is the point of the
family, and it is a real reduction in the guarantee. Any `at-*` package README
should say so plainly rather than let the family's presence imply the hub's
guarantee extends to it.

A standing proposal to move the boundary from "before any store call" to "at the
persistent/transport/export edge" is preserved, unimplemented, in
[`deferred/encryption-boundary-flip.md`](deferred/encryption-boundary-flip.md).
It is not scheduled and requires an explicit decision.

---

## The package-prefix grammar

Every satellite's name opens with a preposition that states what it is and which
side of the boundary it sits on.

| Prefix | Reads as | Sees plaintext? |
|---|---|---|
| `to-` | data goes **to** a backend | **No** — ciphertext only |
| `in-` | runs **in** a framework | No |
| `on-` | get **on** via this method | No |
| `as-` | export **as** a format | **Yes** — post-decrypt, by design |
| `by-` | sync **by** way of | No |
| `at-` | sealed **at** a trusted host | Scoped — see above |

The grammar is load-bearing, not decorative: it means a reviewer can tell from a
package name alone whether a plaintext reference inside it is a bug.

---

## Kernel and services

`packages/hub` is large, but the **always-on kernel is roughly a third of it** —
the vault/collection model, the enclave (encryption), the six-method
`NoydbStore` contract, the owner keyring, schema and refs, the query DSL, and
the via port spine.

Everything else is one of two opt-in shapes:

- **Services** (`src/with-*`) — each with its own subpath export
  (`@noy-db/hub/history`, `/blobs`, `/sync`, …), a `with<Name>()` strategy
  factory passed into `createNoydb()`, and a page in `docs/subsystems/`. Opt out
  and the real implementation is replaced by a no-op or throwing stub and the
  code is tree-shaken away.
- **Via features** (`src/via/*`) — per-*field* capabilities rather than
  per-vault ones. Tree-shaken unless the field factory is imported.

**The service catalog is the product surface.** Adding, removing, or reshaping
one follows the governance checklist in [`../SERVICES.md`](../SERVICES.md) and
trips the bundle-size gate.

### The core mental model

```
createNoydb()  →  Noydb
                    └── openVault()  →  Vault          tenant namespace, own keyrings
                                          └── collection<T>()  →  Collection   typed records, own DEK
```

The store persists `EncryptedEnvelope`s. Nothing below `Collection` is visible
to it.

---

## Ports — the seams that are frozen

A satellite family binds exactly one **port**: a golden-frozen contract subpath.
It never reaches into hub internals, and the hub never imports back.

| Port | Bound by |
|---|---|
| `/to` | storage adapters, including the whole separate `noy-db-to` repo |
| `/on`, `/at`, `/in`, `/by`, `/as` | the matching satellite families |
| `/ui` | `@noy-db/ui` and its framework bindings |
| `/with` | services hooking into the kernel |
| `/cargo` | outward orchestrators — `klum-db`'s lobby, `by-*` transports |
| `/pod` | the manifest-set / pod surface |

`/cargo` is the canonical orchestration seam and its surface is frozen by a
golden test. **Additive changes only** — removing an export from `/cargo` is a
breaking change for a separate repository.

The full port table, the layering law that governs which module may import
which, and the canonical vocabulary live in
[`foundations/architecture-lexicon.md`](foundations/architecture-lexicon.md).
That document is canonical: when a name or a layering question is disputed, it
decides.

### One-way, across repositories

Two satellite repos bind published seams at a version range, and neither is
linked into this workspace:

- **`klum-db → noy-db`** via `@noy-db/hub/cargo`
- **`noy-db-to → noy-db`** via `@noy-db/hub/to`

`@noy-db` must never import `@klum-db` — guarded mechanically. Keep cross-vault
orchestration in klum-db and single-vault primitives here. The pinning rules and
release ordering for those repos live in the family-level `../../CLAUDE.md`.

---

## Portability

`hub/src/**` imports no Node-only module. It has to run in a browser, a Worker,
Deno, and Bun. Reach for `crypto.subtle`; never `node:crypto`, and never an npm
crypto package. This is guarded (checks 2 and 3).

---

## Further reading

- [`../SERVICES.md`](../SERVICES.md) — the service catalog and its governance checklist
- [`../FAMILIES.md`](../FAMILIES.md) — the satellite family taxonomy
- [`subsystems/`](subsystems/) — per-subsystem engineering references
- [`foundations/`](foundations/) — the canonical lexicon, north-star, enclave contract, and governance-placement precedent
- [`adr/`](adr/) — architecture decision records
- [`CI-GUARDS.md`](CI-GUARDS.md) — every mechanical guard and what it actually enforces
- [`deferred/`](deferred/) — design questions parked, with their reasoning intact
