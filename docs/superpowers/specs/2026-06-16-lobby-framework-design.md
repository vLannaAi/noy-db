# Lobby — the framework for a world of vaults

**Status:** Design / positioning spec (north-star). Not an implementation plan.
**Date:** 2026-06-16
**Author:** brainstormed with vLannaAi
**Drives:** pilot-1 epic #440 (FR-1…FR-9, #441–449) and the re-homing of federation #271.
**Supersedes framing of:** the milestone-organization sketch for #440 (see "Pilot-1 → Lobby map" below).

---

## 1. What this is (and is not)

This is **not** a product re-positioning. noy-db's pitch — *your data, your device, your keys, nobody's server* — is unchanged. This is an **internal organization re-centering**: as noy-db has grown, many dimensions have accreted **inside the core** (`@noy-db/hub`), repeatedly raising the kernel ceilings (`vault.ts`, `collection.ts`). The versatility developers love is winning; **ease of use and maintainability** are paying for it.

The goal: a crisp structural axis so new growth lands in the right place instead of swelling the core — while preserving both **versatility** and the **essential ease of use** that the prefix-family convention (`to-/in-/on-/as-/by-/at-*`) created.

**Non-goals:** re-branding the product; turning vaults into a cluster; joining/merging vaults for aggregate value; changing the single-vault developer experience.

---

## 2. The organizing axis: inward vs outward

The right axis is **not** `core / subsystem / adapter / family` flattened together — it is **inward vs outward**, with the existing tiers living *inside* the inward half.

### Inward — the vault, = **noy-db**
`hub/` looks **into** the vault to make it versatile and powerful. **A vault + a store is already a complete, shippable system** — and that is all most of the audience needs.

Inward tiers (definitions locked during design):

- **Core** — the kernel: `vault`, `collection`, keyring/roles, query DSL, envelope/crypto, the store contract.
- **Subsystem** — a **tree-shakeable arm of the core that extends it**. Reach varies: *leaf* (computed/derivation, money — use it or tree-shake it) vs *deeper* arms. Inward subsystems today: computed/derivation, money, i18n, full-text search, snapshots, history/audit ledger. (Their clean extraction from `hub` source is gated on the **kernel-surface extraction** — see §10.)
- **Adapter** — a concrete solution **orchestrated per recipe**.
- **Family of adapters** — a **clear contract that solves a dimension's existential challenge**, exposing a **menu of interchangeable solutions** under one contract. You open the door (`to-`) and see alternatives with different performance / cost / durability / lifecycle (record store, vault store, CAS vs non-CAS needing serialization…), all interchangeable. The current doors are all **two-letter prepositions**: `to · in · on · as · by · at`.

### The edge
`as-*` (export — leaving the vault) and the rest of the families (`to/on/by/at/in`) are the vault talking to the outside world.

### Outward — the world of vaults, = **Lobby** (new)
Beyond the vault lies an ecosystem that **orchestrates many vaults**: federation, interchange/portability, sovereignty/custody, sealing-at-scale, revocation, migration, erasure.

**Crucial finding:** these are **not** a family. A family is *horizontal* — one door, N interchangeable solutions, same focus. These are *vertical* — **one orchestration path with accreting capability**. They don't belong behind a door; they belong **outside the vault**, in their own framework.

---

## 3. Two frameworks: the vault and the world of vaults

> **A noy-db vault is the container. Lobby is Docker.**
> A container runs perfectly alone; the engine orchestrates many — their lifecycle, identity, custody, and exchange.

- **noy-db** stays the clean, inward **vault** framework. `@noy-db/hub` + inward subsystems + edge adapter families.
- **Lobby** is a **separate framework** that **hosts vaults**. It **depends on** noy-db, ships on its own cadence, and serves a **different audience**: the *actor* who operates many vaults (the firm, the clinic, the bank, the insurer), not the individual with one.

This separation is the mechanism that **structurally protects** noy-db's inward simplicity: outward complexity cannot leak back into the core because it lives in a different framework.

---

## 4. What the Lobby is

A **Lobby** has a **dual function**, both captured by the word:

1. **The commons** — many vaults sitting **side by side**, federated. **Non-aggregative**: the value is *not* from joining them. The vaults are **independent**; putting them together creates no added value through merge — which is exactly why **federation** (clean) is the right model and **cluster** (implies merged compute/data) is the wrong one. We place vaults side by side; we do not join them.
2. **The entrance** — the **main door** you pass through to reach a vault, **even a single one** (a single client). The Lobby is the way *in*.

**Loose coupling is a first-class property.** A vault can be **relocated** to a different environment, run by a **different app**, and remain **interoperable** with noy-db vault data. Vaults are portable and sovereign; they are *guests* of a Lobby, not parts of it.

---

## 5. Unit tiering — what docks in the Lobby

Decision: **dock anything; sovereign features for vaults** (tiered).

- The Lobby can carry **any** DB unit (a sqlite file, a duckdb, …) as a **shallow on-ramp** — import, sync, adopt. *(A harbor docks any vessel.)*
- The **deep features** — custody, sealing, **Authority** merge, crypto-shred **Forget**, revocation — **require a noy-db vault**, because they need its keyring, per-record CEK, and consent primitives. A raw sqlite file can be carried and synced but cannot be cryptographically forgotten or carry per-field authority.
- This yields a **migration story**: *dock a legacy unit → graduate it into a vault* to unlock the sovereign tier.

Implication: **"which unit you dock" is itself a family-with-a-menu — at the Lobby layer** (a *unit-driver* family; the noy-db vault is the flagship vessel). The family pattern that didn't fit the orchestration capabilities reappears, correctly, at the docking boundary.

---

## 6. The metaphor & why "vault" already held the surprise

`vault` ← Old French *voûte* ← Vulgar Latin *volta* ← Latin **volvere**, "to roll / to turn." The **original** sense is the **arch** — the springing curve; the *strong room* came later, **because** arched ceilings made strong rooms possible; the *treasury* function came later still. The same root gives **vault = to leap** (pole-vault). So a vault both **spans** and **leaps** — fitting for data that arcs across parties.

> **The shape created the room; the room created the function.**

The orchestrator name **Lobby** was chosen (over *cloister*, *atrium*, *aqueduct*, maritime *wharf/quay*) because it is **instantly understood by everyone** and uniquely names **both** Lobby functions — the commons *and* the entrance — keeping the README effective in the first 20 seconds, with the vault=arch etymology held in reserve as the brand's depth.

---

## 7. The lexicon

**Spine:** `Lobby ⊃ Vault ⊃ Collection ⊃ Record ⊃ Field`

### New — Lobby layer
| Term | Meaning |
|---|---|
| **Lobby** | The outward framework: entrance + federation commons. Hosts vaults. (the one big coinage) |
| **Pool** | A shared vault of common entities (companies, people) that many vaults **reference** by FK. Shared, unowned, long-lived. *(replaces the rejected "directory")* |
| **Relocate** | Move a whole vault to another environment/app (extract + re-key + leave). The headline portability act. |
| **Liberate** | Claim ownership of an **abandoned sealed-owner vault** — the inverse of **Withdraw**. |
| **Deed** | The **inalienable ownership root** (sealed/hidden-owner credential). Owning ≠ operating. |
| **Custodian** | Holder of a **100%-operational but non-owning grant** — cannot revoke / re-key / relocate / grant. The agent/firm. |

### New — merge/sync attributes (pilot-1)
| Term | Meaning |
|---|---|
| **Surface** | An agreed subset (collections / fields / direction / cadence) two parties sync. (FR-7) |
| **Authority** | Which party owns a given **field** on merge (per-field, not per-record). (FR-4) |
| **Provenance** | `_source` / `_sourceTs` lineage — who last wrote each field. (FR-5) |
| **ConflictStrategy** | take-incoming / keep-local / lww / field-authority / manual. (FR-3) |

### Established — keep as-is
`Bundle` · `Compartment` · `Manifest` · `Partition` · `Snapshot` · `Keyring` · `Grant` · `Role` (owner/admin/operator/viewer/client) · `Store` · `Schema/Version` · `Ledger` · `Federation` · `Shard` · `Insight` · verbs `Extract · Adopt · Merge · Migrate · Sync · Withdraw · Forget`.

**Reads in a sentence:** *"A firm is a **Custodian** in the **Lobby**: it holds operating grants to client **Vaults** that all reference one shared **Pool**. The client holds the **Deed**. To onboard, the firm **Relocates** a client's vault as a **Bundle**, **Migrates** it to the current schema, and **Merges** the Pool slice by field **Authority** using **Provenance**. The client can **Withdraw** anytime; an abandoned vault can be **Liberated**."*

---

## 8. Pilot-1 → Lobby map (epic #440)

The 9 FRs are no longer homeless "deltas to slot into milestones" — each is a Lobby capability:

| FR | # | Lobby capability | Lexicon |
|----|---|------------------|---------|
| FR-1 | 441 | Multi-compartment **Bundle** + pre-decrypt **Manifest** | Bundle/Compartment/Manifest |
| FR-2 | 442 | Cross-vault FK-closure **Extract** → multi-compartment Bundle | Relocate/Extract/Partition |
| FR-3 | 443 | **Merge** into an existing vault | Merge/ConflictStrategy |
| FR-4 | 444 | Field-**Authority** resolver | Authority |
| FR-5 | 445 | **Provenance** (`_source`/`_sourceTs`) | Provenance |
| FR-6 | 446 | **Deed** + **Custodian** + **Liberate** (sovereign custody) | Deed/Custodian/Liberate |
| FR-7 | 447 | Scoped sync **Surface** | Surface |
| FR-8 | 448 | **Migrate**-then-Merge (upgrade incoming before reconcile) | Migrate |
| FR-9 | 449 | Multi-compartment export reading the **Pool** | (edge: `as-xlsx`) |

Dependency spine (unchanged from the analysis): FR-1 → {FR-2, FR-3}; FR-5 → FR-4; FR-8 wraps FR-3/4; FR-9 reuses FR-2's FK descriptors; FR-6 is independent (custody topology). FR-9 stays at the **edge** (`as-xlsx`) — it reads across vaults but is an export, not orchestration.

---

## 9. Lobby is partly a re-homing, not all-new

The outward ecosystem already **exists inside `hub`** and is the **seed of Lobby**:

- **Federation #271** — VaultGroup, `withSharding`/routing, crossShardJoin, **Insight** Vault, StateManagement Vault — is outward by nature and a prime candidate to **migrate into Lobby**.
- Single-vault portability/withdrawal (#198/#199/#348, SyncEngine, `diffVault`) are the **inward primitives** Lobby's interchange capabilities build on.
- The `at-*` sealing family is the existing **second trust boundary**; Lobby's custody features compose with it, they don't replace it.

So Lobby v0 is: **(re-homed federation) + (new pilot-1 interchange/custody)**, packaged as one coherent outward framework.

---

## 10. Packaging & the enabler

- **Lobby** ships as its own framework/scope, depending on `@noy-db/hub`. (Exact npm scope is an open question — `@noy-db/lobby*` vs a distinct brand scope — see §12.)
- **Unit-driver family** at the Lobby layer expresses §5's tiering (noy-db vault = flagship; sqlite/duckdb = shallow on-ramp drivers).
- **Inward subsystems are not changed by this spec.** Extracting computed/money/i18n/etc. from `hub` source is a *separate* effort gated on the **kernel-surface extraction** (a small, stable internal core API — long deferred; see CEK epic notes). That extraction is also what lets Lobby attach to a **stable vault API** instead of `hub` internals. It is the real enabler and should be sequenced first for any deep outward feature.

---

## 11. Phased path (north-star → first steps)

1. **Establish Lobby** as a package skeleton depending on `hub`; define the **unit-driver** contract (vault flagship; passthrough driver for foreign units).
2. **Kernel-surface extraction** — the stable internal vault API Lobby binds to (enabler; also unblocks inward subsystem extraction later).
3. **Interchange core (FR-1/2/3 + FR-8)** — Bundle/Compartment/Manifest, cross-vault Extract/Relocate, Merge, Migrate-then-Merge.
4. **Correct merge (FR-5 → FR-4)** — Provenance, then field Authority.
5. **Custody (FR-6)** — Deed/Custodian/Liberate (parallel; independent).
6. **Mesh + Pool (FR-7, Pool, FR-9 edge)** — Surface sync; the Pool reference vault; multi-compartment export.
7. **Re-home federation #271** into Lobby once the boundary is proven.

Each phase is its own spec → plan → implementation cycle. This document is the shared frame they all reference.

---

## 12. Open questions

- **npm scope/brand for Lobby** — `@noy-db/lobby` (one ecosystem, clear lineage) vs a distinct brand (stronger Docker:container separation). Leaning `@noy-db/lobby` for discoverability.
- **Deed mechanism** — sealed-owner credential as an extension of `#197` sealed-passphrase (unlock) into **ownership establishment**; exact key-topology TBD in the FR-6 spec.
- **Pool authority defaults** — does the Pool ship a default Authority policy, or is it always app-supplied (Insight-Vault-style engine-vs-policy split)? Leaning app-supplied.
- **Foreign-unit graduation** — is "dock sqlite → graduate to vault" a Lobby command or a one-off Relocate? Likely a Lobby `graduate()` built on Migrate + Adopt.
- **Kernel-surface extraction scope** — minimum stable API Lobby needs vs the full inward-subsystem extraction (do the minimum first).
