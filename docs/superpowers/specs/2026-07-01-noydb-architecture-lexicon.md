# noy-db — canonical architecture & lexicon

> **Status:** canonical (2026-07-01). Supersedes the *vocabulary* of
> `2026-06-30-target-architecture-north-star.md` (the north-star's concentric-domains
> intent still holds; this doc fixes the labels). Goal, in the owner's words: *"put order
> in the house with clear architecture and self-explaining labels."* Every term is chosen
> to be **functional** (it marks a real boundary) and **self-explanatory** (a seasoned dev
> reads it correctly on sight), drawn from adopted architecture vocabulary — **microkernel +
> services**, **data-at-rest**, and **logistics**.

## The model — a containment nest

```
family — the satellites: to- in- on- as- by- at-   (separate packages)

hub  (@noy-db/hub)
├─ kernel — the always-on, mandatory core: vault · collection · query · keyring · bus
│    └─ enclave — self-contained, frozen-interface, swappable:
│                 encryption functions + keys + data format
└─ layers — optional, tree-shaken; each a  with-<name>/  folder + a  with<Name>()  factory
     · service — an in-vault capability (history, blobs, aggregate, crdt, …)
     · cargo   — the layer that manages pods  (used by klum)
     · pod     — serialize a vault ⇄ a pod  (the saved / at-rest / transportable artifact)
```

Containment: **enclave ⊂ kernel ⊂ hub**; **layers** sit beside the kernel inside the hub;
**family** is outside the hub. `[layers]` is an **organizational** grouping today — it is the
seam where services may later harden into a real runtime **plug-in interface**.

## Definitions

| Term | Definition |
|---|---|
| **hub** | the `@noy-db/hub` package — the whole machine. |
| **kernel** | the always-on, mandatory core (vault · collection · query · keyring · the service bus). One center word; "core" is a description of it, not a separate level. Holds the enclave. |
| **enclave** | a **minimal, self-contained** unit *inside* the kernel (no dependency on other kernel parts) with a **frozen interface** to the kernel — therefore **replaceable**. It owns the open↔close boundary: the **encryption functions + keys** and the **data format** (codec). noy-db ships one enclave — full AES-256-GCM, zero-knowledge. A trusted wrapper can supply *its own* enclave (see nit-db). |
| **service** | a tree-shakeable capability that ships **by default** and is **removed at build** when unused (the microkernel-with-services model — not a "plugin" you add). Each is a `with-<name>/` + `with<Name>()` layer. |
| **layer** | the organizational grouping of the `with-*` units (services, plus `cargo` and `pod`). A soft bracket now; a future plug-in seam. |
| **cargo** | the **layer** of services + interfaces required to **manage pods** — the multi-vault management plane **klum** binds: custody, deed, diff, distributed query, addressing. (Formerly the mislabeled `/kernel` subpath.) |
| **pod** | a vault **serialized and saved** — the **at-rest**, self-contained, transportable artifact (the `.noydb` file). Formerly "bundle". |
| **vault** | a live tenant namespace with its own keyrings — a kernel concept; the *inside*. |
| **family** | the satellite packages, by prefix: `to- in- on- as- by- at-`. |

Retired terms: **fleet** (dropped — not a noy-db concept), and the discarded candidates
**capsule / vessel / cargo-as-a-unit / image / chest** (the naming path that led here).

## Who binds what

| Consumer | Binds | Reaches |
|---|---|---|
| apps · **noy-db-ui** · **noy-db-docs** | the kernel's public API (+ chosen **service** layers; ui also `describe`) | full ZK, cannot touch the enclave |
| **klum-db** | the **cargo** layer (+ **pod**) | full ZK — orchestrates pods *through* the fixed enclave; never swaps it |
| **nit-db** | its own **enclave** via the deep kernel seam | may drop crypto to partial/none, hold its own data format + Thai features |

## The security invariant (restated in the new terms)

Encryption lives **only** in the enclave, and **only** a wrapper binding the deep kernel seam
can replace it. Apps and klum **physically cannot reach the enclave** — so noy-db's promise
"encryption cannot be disabled" stays **absolute** for them. **nit-db is a distinct product**
that opts into a different, *explicit* tradeoff (PDPA/GDPR-level or lower) at the one seam built
for it. It is a **wrapper, not a copy** — it reuses the kernel + services and swaps only its
enclave, so it stays in sync with noy-db by construction.

## What this triggers (downstream — each its own plan, not this doc)

1. **cargo seam.** Rename the mislabeled `@noy-db/hub/kernel` subpath to the **cargo** seam;
   migrate klum's bare-barrel + `/kernel` + `/bundle` imports onto `cargo` (+ `pod`); add the
   klum-side import guard. (This is the pending klum seam-hardening — now correctly named.)
2. **bundle → pod.** Rename the artifact + its API (`with-share/bundle` → the `pod` layer,
   `writeNoydbBundle` → `writePod`, …) with deprecated aliases through one version.
3. **enclave (the nit-db enabler).** Freeze the enclave's kernel interface so it is replaceable
   — this is the parked "Phase 4 / encryption transformer", reframed as *"make the enclave a
   swappable unit behind a frozen kernel seam."*
4. **Retire fleet** from any doc/label.

## Open (deliberately not decided here)

- The exact call shape of `withCargo()` / `withPod()` (injected strategy vs. namespace of functions).
- Whether services harden from build-time tree-shaken units into runtime plug-ins (the `layer` → plug-in evolution).

## Addendum: Doors (2026-07-02)

S5 ("family doors + kernel diet") gave each satellite **family** exactly one named,
golden-frozen contract subpath — a **door** — instead of loose root-barrel exports or a
mislabeled shared subpath. Full design: `2026-07-02-family-doors-kernel-diet-design.md`.

### The door table

| Subpath | Physical home | Bound by (family) | Frozen by (golden) |
|---|---|---|---|
| `/to` | `kernel/to/` | `to-*` stores | `to-surface.golden.json` |
| `/on` | `kernel/on/` | `on-*` unlock | `on-surface.golden.json` |
| `/at` | `kernel/at/` | `at-*` sealing | `at-surface.golden.json` |
| `/in` | `kernel/in/` | `in-*` frameworks | `in-surface.golden.json` |
| `/by` | `kernel/by/` | `by-*` transports | `by-surface.golden.json` |
| `/ui` | `kernel/ui/` | noy-db-ui (`describe()`) | `ui-surface.golden.json` |
| `/with` | `kernel/with/` | `with-*` services (internal hook seam) | `with-surface.golden.json` |
| `/as` | `src/as/` (layer door) | `as-*` exporters | `as-surface.golden.json` |
| `/cargo` | `src/with-cargo/` (layer door) | klum-db lobby | `cargo-surface.golden.json` |
| `/pod` | `src/with-pod/` (layer door) | klum-db, backup consumers | `pod-surface.golden.json` |

Plus two contracts that aren't family doors but are golden-frozen the same way:
the **root barrel** (`src/index.ts`, the flat app-developer API — `root-barrel-surface.golden.json`,
438 values / 390 types) and the **enclave barrel** (`kernel/enclave/index.ts`, the fork-swap
contract a sister project like nit-db replaces wholesale — `enclave-surface.golden.json`),
plus the **kernel API manifest** (`Noydb`/`Vault`/`Collection` public prototype surface —
`kernel-api.golden.json`: Noydb 75 / Vault 78 / Collection 82 methods).

### The layering law

**Imports point inward only:** `family → door → service layer → kernel spine → enclave`.

- The **kernel spine** (`noydb.ts`, `vault.ts`, `collection.ts`, `query/`, `types.ts`,
  `errors.ts`, `schema.ts`, `refs.ts`, `validation.ts`, `collection-config.ts`, `cache/`,
  `util/`, `meta/`, `policy/`, `write-queue.ts`, `constants.ts`, `events.ts`, `debug.ts`,
  `env-check.ts`) is restricted: it may import `kernel/with/` (the hook seam) and
  `kernel/enclave/` (only via its barrel), but never another door folder and never a
  `with-*` service directly (a dynamic `import()` is the sanctioned escape hatch).
- **Doors are views, not new code paths.** A door may re-export a contract whose
  implementation lives in a service (e.g. `/on` re-exports `UnlockedKeyring` from
  `with-party/team`) — importing the door *is* the opt-in, so this costs nothing in
  tree-shaking. Door folders may not import each other.
- Enforced mechanically by two new `check:architecture` checks: `door-layering` (the
  spine/door import-direction rules above) and `enclave-barrel-only` (nothing outside
  `kernel/enclave/**` reaches past its barrel).

### Deprecated aliases

Three old subpaths/names remain as **deprecated aliases** (kept working, `@deprecated`
JSDoc naming the replacement, removed only on a coordinated version bump):

- `/adapter` → superseded by `/to` (the store contract).
- `/describe` → superseded by `/ui` (the `describe()` contract).
- `/kernel` → superseded by `/cargo` (already deprecated pre-S5; unchanged here).

The old `/store` subpath was **removed outright** (not aliased) — it was internal plumbing
with no external satellite importer; the code moved to `src/with-store/` (root-barrel-only).
