# Target architecture — the noy-db microkernel (north star)

> **Status:** north-star design (2026-06-30). The umbrella the phase specs serve. Goal, in the owner's words: *"regain human control on clear, organized partitions and domains."* This doc defines the target shape; the phase specs/plans (reorg, edge-crypto, …) and the overnight reviews are the route to it.

## The thesis

noy-db should be a **microkernel**: a tiny always-on core, surrounded by concentric layers that each have **one responsibility, a named seam, and the ability to be understood and changed in isolation**. Adding a capability must flow into the right layer — never swell the kernel. Today it doesn't: the architecture review found the three always-on files at **13,525 LOC** (vs a documented ~6,500 core), ~13 subsystems hard-wired into the kernel by named strategy fields, and the kernel-surface ratchet rising ~45% as an approval queue. The refactoring closes that gap.

## The concentric domains

From the outside in — each is a partition with a clear boundary:

| Layer | What it is | Seam / how it plugs in | State today |
|---|---|---|---|
| **Family packages** | the `to- in- on- as- by- at-` satellites — the only code that touches the wire/edge | npm packages, prefix grammar, bind published subpaths | organized by prefix; some live in `noy-db-to` |
| **Optional subsystems** | opt-in capability *dimensions* — lookup · commit · formula · shape · audit · **fork** · **share** · party | `with-*` source folders + `with<Name>()` strategy + subpath export, registered on the **subsystem-bus** | 8 dimension folders on `main`; bus under-adopted (only periods+guards migrated) — **Phase 2 ✓ + 5** |
| **Encryption transformers** | encryption as a **pluggable codec at the boundary**, not a fixed invariant — enabling **full / partial / no** encryption per store/field | a typed `StoreEdgeCodec` seam applied at every real egress (disk/net/export) | invariant is "encrypt before any store call"; `ramCiphertext` is an inert hook — **Phase 4** |
| **Surfaces & contracts** | the **outbound exchange seams** to the sister frameworks | `@noy-db/hub/kernel`→klum-db · `@noy-db/hub/adapter`→noy-db-to · `collection.describe()`+design-tokens→noy-db-ui · published packages→noy-db-docs | kernel+adapter exist; ui+docs implicit — **Phase 3** |
| **Core essentials** | what noy-db *is*: vault · collection · query basics · keyring · schema/refs · envelope crypto | the always-on classes | correct but bloated (god-objects) — **Phase 1 + 5** |
| **Kernel / microkernel** | the minimal runtime + the extension bus everything registers on | `kernel/` (frozen seam) + `subsystem-bus.ts` | real but small relative to what bypasses it — **Phase 5** |

## The three north-star commitments (owner's framing, beyond the current specs)

1. **Encryption is a transformer, not a law.** Generalize the edge-crypto codec from "plaintext-in-RAM / encrypt-at-edge" to a **configurable transform** that can be **full, partial (per collection/field), or none**. This makes an unencrypted or selectively-encrypted datastore a *supported configuration*, not a fork — the codec is chosen at the boundary. (Widens the edge-crypto spec.)
2. **Every sister-framework exchange is an explicit, documented contract.** Four seams, first-class and versioned: `/kernel` (klum-db orchestration), `/adapter` (noy-db-to stores), `describe()` + `--nui-*` tokens (noy-db-ui), and the published-package surface (noy-db-docs). The "surfaces & contracts" layer is where cross-framework coupling is allowed to live — and *only* there.
3. **The microkernel is the evolution model.** New capability = a new dimension that registers on the bus, never a kernel edit. The `with-*` dimensions + the subsystem-bus are the seed; the success test is that `collection.ts`/`vault.ts` *stop growing* when a subsystem is added.

## Success criteria (how we know we're done)

- A reader can open `hub/src/` and **see the partitions** (family / `with-*` subsystems / kernel + plumbing) without a guide.
- The four cross-framework contracts are named, documented, and the *only* places coupling crosses a repo boundary.
- Encryption is a chosen codec: a config produces a full / partial / unencrypted store with no source fork.
- Adding a subsystem touches its own `with-*` folder + a bus registration — **not** `collection.ts`/`vault.ts`.
- The kernel-surface numbers reconcile with the docs (the "minimalist core" claim becomes load-bearing again).

## Execution roadmap (each phase = one reviewed PR, checkpointed)

| Phase | What | Serves | Spec |
|---|---|---|---|
| **0 (done)** | H-1/M-1 forget() erasure fixes; built-in MemoryStore | correctness floor | shipped `8e6a3217`, `e1f5ba90` |
| **1** | Extract `record-codec.ts` (envelope+crypto+CEK+sealed dual-read; `buildEnvelope()`) | de-dup before move; the encryption-transformer seed; "encryption-in-the-hub" as a module | reorg-plan Prerequisite + edge-crypto P0 |
| **2** | `with-*` dimension reorg (+ catalog-drift fixes + test layout) | the optional-subsystem partition | `…-hub-src-with-dimension-reorg-design.md` |
| **3** | Formalize the 4 surfaces & contracts (kernel/adapter/ui/docs) as documented seams | the exchange layer | this doc → a contracts spec |
| **4** | Encryption transformer: `StoreEdgeCodec` seam → partial/none capability → dissolve `to-memory` | the transformer layer | `…-edge-crypto-kernel-optimization-design.md` (widened per commitment 1) |
| **5** | Kernel-shrink: god-object decomposition + subsystem-bus adoption | the microkernel | refactoring review items #5–#11 |

Independent: `noy-db-docs` extraction (orthogonal; gated on its own source-of-truth question — see `reviews/2026-06-30-noy-db-docs-extraction.md`); the remaining Medium security items (M-2…M-5).

## Guardrails for the autonomous run

- Each phase lands as **one reviewed PR** through protected `main`; nothing irreversible without a checkpoint.
- **Public API + `dist/` stay byte-identical** through the reorg (subpaths frozen).
- **Security gates are hard** (Phase 4): a type-level codec, preserved sealed non-residency, `forget()` RAM-scrub, swap care — Phase 4 does not ship until these hold.
- TDD + adversarial review on every code phase; the security spine is re-audited after Phases 1 and 4.
