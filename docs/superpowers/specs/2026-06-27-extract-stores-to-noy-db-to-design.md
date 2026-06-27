# Extract non-essential storage adapters into a `noy-db-to` repo

**Date:** 2026-06-27
**Status:** Design — pending review
**Scope:** `noy-db` (source) + new `noy-db-to` repo. Does **not** touch `klum-db`, `nit-db`, or the UI packages.

## Context

`lanna-db` is a working directory, not a repo or package — it holds several independently
git-tracked repos of the noy-db family. `noy-db` is a pnpm+turbo monorepo of **68 packages**; its
CI runs the test job serially (`turbo test --concurrency=1`) across a Node 20/22 matrix plus a
3-OS interop job, which is the main source of its slow CI. The `to-*` storage family alone is 21
packages, and the cloud adapters drag cloud-credential surface into the core repo.

This design splits the storage family across two repos along a single curation line, and reorganizes
both repos around a family-folder convention — so each repo is smaller, CI is faster and uniform,
versioning is independent, and a developer can navigate the family from its folder layout alone.

### Goals

1. **Level repo size** — shrink `noy-db` by relocating ~15 storage adapters.
2. **Faster, uniform CI** — fewer packages and no cloud creds in core CI; a shared CI shape across
   the family repos.
3. **Focused Claude-Code context** — a single-purpose stores repo, and family-grouped folders.
4. **Independent versioning** — the stores repo versions and releases on its own line, decoupled
   from noy-db's churn via a published contract.
5. **Simplified access** — the folder layout teaches the family; the repo split teaches
   essential-vs-extended.

### Non-goals

- **Bundle size.** The cloud SDKs are already *optional peer-deps*; nothing ships them unless
  imported. This split changes CI/cognitive load, not runtime weight.
- **Splitting other families** (`in-/on-/as-/by-/at-`). They stay in `noy-db`.
- **Cross-repo in-tree visibility** (submodules / generated catalogs). Decorative; dropped.
- **Folding `noy-db-ui` into noy-db.** Separate decision, out of scope here.

## Decisions (settled)

### D1 — The split line: essential-default stays, everything else moves

The classification criterion is a single question: *is this a default, essential store?* This avoids
the multi-qualifier "networked/cloud/server" definition (which leaves mixed local/network adapters
straddling the cut) and classifies every current and future store unambiguously.

**Stay in `noy-db`** (essential defaults):
- `to-memory` — every test target; ephemeral
- `to-file` — canonical local persistence
- `to-browser-idb` — the browser default (async, large quota, transactional)

**Move to `noy-db-to`** (everything else, 15 packages):
- `to-browser-local` (niche fallback), `to-aws-s3`, `to-aws-dynamo`, `to-cloudflare-d1`,
  `to-cloudflare-r2`, `to-postgres`, `to-mysql`, `to-turso`, `to-supabase`, `to-smb`, `to-ssh`,
  `to-webdav`, `to-nfs`, `to-drive`, `to-icloud`

**Open minor (O1):** `to-probe` (diagnostic) and `to-meter` (a metering decorator) carry the `to-`
prefix but are not real storage targets. They stay in `noy-db` for now (tightly coupled to hub
testing). A later option is to move them out of `to/` into a `dev/` family folder; not done here.

### D2 — Folder convention

- **Directory basename == package short name** (`to-aws-s3`), so `pnpm --filter`, grep, and GitHub
  search map 1:1 to a folder with no translation.
- **A family grouping folder (`to/`, `in/`, …) is used only in a multi-family repo.**
  - `noy-db` is multi-family → `packages/<family>/<pkg>`, e.g. `packages/to/to-memory`.
  - `noy-db-to` is single-family → packages sit flat at the repo root, e.g. `to-aws-s3`. The repo
    name is the grouping; no redundant `/to/` middle folder (which also isn't in the npm name).

```
noy-db/packages/                         noy-db-to/
├── hub/                                 ├── to-browser-local/
├── cli/  create-noy-db/  attestation/   ├── to-aws-s3/   to-aws-dynamo/
├── to/   to-memory to-file              ├── to-cloudflare-d1/  to-cloudflare-r2/
│         to-browser-idb                 ├── to-postgres/ to-mysql/ to-turso/ to-supabase/
│         (to-probe to-meter — O1)       ├── to-smb/ to-ssh/ to-webdav/ to-nfs/
├── in/   on/   as/   by/   at/          ├── to-drive/ to-icloud/
                                         ├── pnpm-workspace.yaml  → ['to-*']
                                         └── CLAUDE.md  .github/  release.yml
```

### D3 — The published contract (the seam)

Today every `to-*` package is already constrained by architecture guard #4
(`stores-ciphertext-only`): a store may import only the ciphertext-facing slice of the hub. That
narrow surface becomes a **stable published subpath, `@noy-db/hub/adapter`**, exporting:
- the `NoydbStore` interface (the 6-method contract: `get/put/delete/list/loadAll/saveAll` + the
  optional extension methods),
- the ciphertext envelope type (`EncryptedEnvelope`) and the snapshot/op types stores pass through
  (`VaultSnapshot`, `TxOp`, `StoreCapabilities`, `StoreTime`, `ListPageResult`),
- the store-facing error classes (`ConflictError`, `NetworkError`, `StoreCapabilityError`).

> **Naming note:** `@noy-db/hub/store` is **already taken** — it currently exports hub-internal store
> *routing / middleware / sync-policy* machinery, not the adapter contract. The new seam is therefore
> named `@noy-db/hub/adapter` ("a store adapter binds to `@noy-db/hub/adapter`").

This mirrors how `klum-db` binds only to `@noy-db/hub/kernel`. The existing parameterized
adapter-conformance harness (`@noy-db/test-adapter-conformance`, today private/`0.0.0`/source-only,
exporting `runStoreConformanceTests(name, factory, cleanup?)`) is **promoted in place to a published
package** — keeping its current name to avoid renaming 21 store devDeps + 21 test imports — so the
external repo runs the *same* contract tests against the *published* hub. Because a publishable kit
must peer `@noy-db/hub` at a **range**, it takes a narrow, explicit **exemption from architecture
guard rule #1** (it is test tooling, not a satellite). As of P0, `check-architecture.mjs` scans
only `packages/`, so the kit currently satisfies rule #1 by being outside the scan — the explicit
exemption is pre-emptive and becomes active in P1 (when packages move under `packages/*/*` or the
scan broadens to `test-harnesses/`).

### D4 — Versioning

- `noy-db` keeps **lockstep** versioning on its line (currently `0.2.0-pre.30`), minus the moved
  packages.
- `noy-db-to` gets its **own independent line** (e.g. `0.2.0-pre.N`) and peers `@noy-db/hub` at a
  **range** (`^0.2.x`), never `workspace:*`. It re-publishes only when (a) a store changes, or
  (b) the `@noy-db/hub/store` contract changes (which surfaces as a peer-range bump — the explicit
  signal that the contract moved). Routine noy-db feature releases never force a `noy-db-to` rebuild.

### D5 — `to-nfs` rebuilt fresh (no `to-file` dependency)

`to-nfs` currently reuses `to-file`. NFS violates `to-file`'s implicit local-POSIX invariants
(atomic rename, working fsync, meaningful locks): over NFS you face `ESTALE`, close-to-open
consistency, unreliable locking, root-squash uid/gid mapping, and latency that demands
cache/retry. A quality NFS adapter is a different implementation, not a `to-file` subclass.
Rebuilding it standalone also removes the **only** dependency edge from `noy-db-to` back into a
`noy-db` store — so `noy-db-to` ends with **zero inbound deps to noy-db's stores**, peering only the
hub. (`to-supabase → to-postgres` and `to-cloudflare-r2 → to-aws-s3` are both intra-`noy-db-to`, so
they stay normal workspace deps.)

### D6 — Architecture guards split

- In `noy-db`, guards #1 (`peerDependencies['@noy-db/hub'] = "workspace:*"`) and #4
  (`stores-ciphertext-only`) still apply to the essential stores.
- `noy-db-to` gets a sibling guard (the store-world twin of klum-db's `no-outbound-klum-import`):
  every store peers `@noy-db/hub` at a **range** (never `workspace:*`), and imports only the
  published `@noy-db/hub/adapter` subpath.

### D7 — CI

- `noy-db` CI shrinks (15 fewer packages; no cloud creds).
- `noy-db-to` CI: build/lint/typecheck/test against the **published** hub + the conformance kit;
  cloud adapters **mock-tested by default**, with real-cloud runs gated to a scheduled/manual
  workflow (creds live only here, not in core).
- **Uniform CI** via a shared **reusable GitHub workflow** that all family repos call with params
  (test command, Node matrix). Rollout to all repos is a follow-up phase, not a blocker.

### D8 — npm & release

- Package **names are unchanged** (`@noy-db/to-aws-s3`, …). The `@noy-db` scope is published from
  two repos — npm allows this; the scope is just a namespace.
- `noy-db-to` replicates `noy-db`'s release discipline: `release.yml` triggered by GitHub Release /
  explicit `workflow_dispatch confirm=PUBLISH`, `npm whoami` scope check, `--provenance`,
  `@latest`/`@next` dist-tag routing. **Never publish without explicit user confirmation.**
- **Publisher handoff:** once `noy-db-to` publishes a moved package at a higher version under the
  same name+tag, consumers upgrade transparently via `npm i`. `noy-db` must **stop** publishing the
  moved packages (remove them from its release set) so two publishers never race — exactly the
  precedent set when `@klum-db/*` was removed from noy-db's `release.yml` during the klum-db split.

## Migration phases (high level; detailed plan to follow)

- **P0 — Seam first (additive, no moves).** Introduce `@noy-db/hub/adapter` subpath; promote/publish
  `@noy-db/store-conformance`. Migrate the essential stores' contract imports to the subpath and
  verify they build/test against it. CI green. *(Detailed in `plans/2026-06-27-store-seam-and-conformance-kit.md`.)*
- **P1 — Folder reorg in noy-db.** Move packages into `packages/<family>/<pkg>`; update
  `pnpm-workspace.yaml` glob (`packages/*` → also `packages/*/*`). Names unchanged; turbo/changesets
  are path-agnostic. CI green.
- **P2 — Scaffold `noy-db-to`.** pnpm workspace (`to-*`), shared tooling, CI calling the reusable
  workflow, `release.yml`, sibling architecture guard, ranged peer on `@noy-db/hub`, consumes the
  conformance kit.
- **P3 — Relocate stores in batches.** Per batch: copy package into `noy-db-to`, convert peer to
  ranged, run conformance against published hub; delete from `noy-db`; drop from noy-db's release
  set, changesets, `features.yaml`, and docs.
- **P4 — Rebuild `to-nfs`** standalone (sever `to-file`). *(Staged fallback: relocate as-is with a
  temporary ranged dep on published `@noy-db/to-file`, then rewrite — only if P3 timing demands it.)*
- **P5 — First `noy-db-to` release** + consumer/docs updates; confirm noy-db no longer publishes the
  moved packages.
- **P6 — (Optional) uniform CI** reusable workflow adopted across `klum-db`, `nit-db`, `noy-db`,
  `noy-db-to`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Version/publisher handoff race | noy-db removes moved pkgs from release set before/at first noy-db-to publish (klum-db precedent). |
| Contract drift between repos | `@noy-db/hub/adapter` is a versioned subpath; `@noy-db/store-conformance` runs in noy-db-to CI against published hub. |
| Guard drift | Port guards #1/#4 to a noy-db-to sibling guard; keep both in CI. |
| Cloud creds | Real-cloud tests gated to scheduled/manual workflow in noy-db-to only. |
| Cross-repo dep via `to-nfs`→`to-file` | Rebuild `to-nfs` standalone (D5). |

## Open questions

- **O1:** Final home of `to-probe` / `to-meter` (stay in `to/`, or move to a `dev/` family). Default: stay.
- **O2:** `to-nfs` immediate rewrite (P4) vs. staged relocate-then-rewrite. Default: immediate.
