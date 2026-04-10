# Session handover

> **Purpose:** context for the next Claude Code session. Read this first —
> it will save you 10 minutes of re-discovery.
>
> **Updated:** 2026-04-10 — v0.10.0 published; npm cleanup in progress; v0.11 package renaming planned.

---

## What this project is

NOYDB is a zero-knowledge, offline-first, encrypted document store with
pluggable backends and multi-user access control. TypeScript monorepo,
Node 18+ and modern browsers. See `SPEC.md` for the full design reference;
`CLAUDE.md` for coding conventions.

**Privacy rule (CLAUDE.md):** never name the first consumer (an accounting
firm). Use "accounting firm", "first consumer", or "the platform". Grep for
the actual name before any commit or publish that touches user-facing copy.

---

## Current state: v0.10.0 on npm — npm cleanup in progress

```
main  21c4465  chore(ci): pause npm publishing — package rename in progress
```

Working tree clean. **npm publishing is PAUSED** — the release workflow
(`.github/workflows/release.yml`) now requires manual `workflow_dispatch`
instead of triggering on GitHub Release. Do not re-enable until npm cleanup
is complete and v0.11 renames are ready to ship.

**Open milestones:** v0.11.0 (package renaming), v0.12.0, v0.13.0.

---

## npm cleanup status — DO THIS BEFORE ANY PUBLISHING

### The plan (execute in order)

**Step 1 — Try again tomorrow (2026-04-11):**
Some versions that are currently blocked by the 72h window will have expired.
Retry unpublishing any remaining versions from the old package names.

**Step 2 — Send npm support email:**
Go to **https://www.npmjs.com/support** (available on free plan).
Request hard deletion of all pre-v0.10.0 versions across the old package names.
Key points to include:
- Pre-release cleanup before first public launch
- Zero downloads across all affected versions
- All versions already deprecated with migration messages
- Packages to clean: `@noy-db/core`, `@noy-db/file`, `@noy-db/memory`,
  `@noy-db/vue`, `@noy-db/pinia`, `@noy-db/nuxt`, `@noy-db/s3`,
  `@noy-db/browser`, `@noy-db/dynamo`, `@noy-db/create`
- Versions: everything `<0.10.0` plus the stuck last-versions

**Step 3 — Once registry is clean, implement v0.11 renames (see below):**
Then re-publish all packages under new names.

### Current npm state (as of 2026-04-10)

**New packages at 0.10.0 — FORCE-UNPUBLISHED (will need re-publishing):**
- `@noy-db/store-file@0.10.0` — deleted
- `@noy-db/store-memory@0.10.0` — deleted
- `@noy-db/store-browser-local@0.10.0` — deleted
- `@noy-db/store-browser-idb@0.10.0` — deleted
- `@noy-db/store-aws-s3@0.10.0` — deleted
- `@noy-db/store-aws-dynamo@0.10.0` — deleted
- `create-noy-db@0.10.0` — deleted

**Still live at 0.10.0 (good — keep these):**
- `@noy-db/core@0.10.0` ✓
- `@noy-db/vue@0.10.0` ✓
- `@noy-db/pinia@0.10.0` ✓
- `@noy-db/nuxt@0.10.0` ✓

**Old package names — stuck, deprecated, need npm support to fully remove:**

| Package | Remaining versions | Status |
|---|---|---|
| `@noy-db/core` | 0.1.0–0.9.0 | All deprecated ✓ |
| `@noy-db/file` | 0.1.0–0.3.0 (>72h), 0.5.0–0.9.0 | All deprecated ✓; E405 on unpublish |
| `@noy-db/memory` | 0.1.0 (>72h), 0.1.1–0.9.0 | All deprecated ✓ |
| `@noy-db/vue` | 0.1.0 (>72h), 0.1.1–0.9.0 | All deprecated ✓ |
| `@noy-db/pinia` | 0.3.0 (>72h), 0.4.0–0.9.0 | All deprecated ✓; E405 on unpublish |
| `@noy-db/nuxt` | 0.3.0 (>72h), 0.4.1–0.9.0 | Needs deprecation; E405 on unpublish |
| `@noy-db/s3` | 0.9.0 | Deprecated ✓; E422 on force-delete |
| `@noy-db/browser` | 0.9.0 | Deprecated ✓; E422 on force-delete |
| `@noy-db/dynamo` | 0.9.0 | Deprecated ✓; E422 on force-delete |
| `@noy-db/create` | all gone | ✓ fully unpublished |

**npm error codes reference:**
- **E405** — "has dependent packages in the registry" — another package peer-deps on this one
- **E422** — full package DELETE blocked (package first published >72h ago; npm policy)
- **EUSAGE** — refusing to delete last version without `--force`
- `@noy-db/nuxt@0.10.0` peer-deps on `@noy-db/vue`, `@noy-db/pinia`, `@noy-db/core` — this is why pinia/vue old versions get E405

---

## v0.11.0 — Package renaming (issue #150)

### New naming taxonomy

| Category | Prefix | Old name | New name |
|---|---|---|---|
| Core runtime | (none) | `@noy-db/core` | `@noy-db/hub` |
| Framework integrations | `in-` | `@noy-db/vue` | `@noy-db/in-vue` |
| | | `@noy-db/pinia` | `@noy-db/in-pinia` |
| | | `@noy-db/nuxt` | `@noy-db/in-nuxt` |
| | | `@noy-db/yjs` | `@noy-db/in-yjs` |
| Storage backends | `to-` | `@noy-db/store-file` | `@noy-db/to-file` |
| | | `@noy-db/store-memory` | `@noy-db/to-memory` |
| | | `@noy-db/store-browser-local` | `@noy-db/to-browser-local` |
| | | `@noy-db/store-browser-idb` | `@noy-db/to-browser-idb` |
| | | `@noy-db/store-aws-s3` | `@noy-db/to-aws-s3` |
| | | `@noy-db/store-aws-dynamo` | `@noy-db/to-aws-dynamo` |
| Auth | `auth-` | `@noy-db/auth-webauthn` | unchanged |
| | | `@noy-db/auth-oidc` | unchanged |
| Scaffolder | (none) | `create-noy-db` | unchanged |

**Rationale:** `in-` = "use noy-db in this framework"; `to-` = "persist noy-db to this backend";
`hub` = the central encrypted runtime connecting all `in-*` and `to-*` packages.

**Do NOT publish anything to npm until the registry is clean and v0.11 renames are implemented.**

### Scope of v0.11 rename work
- Rename all `packages/*` directories
- Update all `package.json` names and cross-package peerDependencies
- Update `CLAUDE.md`, `SPEC.md`, `ROADMAP.md`
- Update CI workflows (package paths, names)
- Update `scripts/release.mjs` exclusion list
- Verify all 1065+ tests pass after rename

---

## What v0.10 added (already shipped — do not re-implement)

| # | What | Details |
|---|------|---------|
| — | API renames | `NoydbAdapter` → `NoydbStore`, `defineAdapter()` → `createStore()`, `NoydbOptions.adapter` → `.store`, `AdapterCapabilityError` → `StoreCapabilityError` (code `'STORE_CAPABILITY'`), `AdapterCapabilities` → `StoreCapabilities`, `runAdapterConformanceTests` → `runStoreConformanceTests` |
| — | Vault rename | `class Compartment` → `class Vault`, `openCompartment()` → `openVault()`, `listCompartments()` → `listVaults()`, `CompartmentSnapshot` → `VaultSnapshot`, `CompartmentBackup` → `VaultBackup` |
| — | Package renames | `@noy-db/file` → `@noy-db/store-file`, `@noy-db/memory` → `@noy-db/store-memory`, `@noy-db/browser` → split (`store-browser-local` + `store-browser-idb`), `@noy-db/dynamo` → `@noy-db/store-aws-dynamo`, `@noy-db/s3` → `@noy-db/store-aws-s3`, `@noy-db/create` → `create-noy-db` |
| — | StoreCapabilities | Added `casAtomic: boolean` and `auth: StoreAuth` fields |
| #139 | IDB CAS fix | `store-browser-idb` uses single `readwrite` IDB transaction for atomic check-and-set |
| — | S3 SDK cleanup | `store-aws-s3` uses `@aws-sdk/client-s3` directly — dropped `MinimalS3Client` shim |

**casAtomic per store:** store-memory true, store-file false (TOCTOU), store-browser-local true (sync), store-browser-idb true (single readwrite tx), store-aws-dynamo true (ConditionExpression), store-aws-s3 false (two HTTP calls).

---

## What v0.9 added (already shipped — do not re-implement)

| # | Module | What it does |
|---|--------|--------------|
| #131 | `core/collection.ts` | `conflictPolicy: 'last-writer-wins' \| 'first-writer-wins' \| 'manual' \| fn`. Manual mode emits `sync:conflict` with `resolve` callback. |
| #132 | `core/crdt.ts` | `crdt: 'lww-map' \| 'rga' \| 'yjs'` per-collection. `collection.getRaw(id)` returns `CrdtState`. `mergeCrdtStates`, `resolveCrdtSnapshot`, `buildLwwMapState`, `buildRgaState`. |
| #133 | `core/sync.ts` | `push(comp, { collections })`, `pull(comp, { collections, modifiedSince })`, `sync(comp, { push, pull })`. Adapter may add `listSince?()` for server-side filtering. |
| #134 | `core/presence.ts` | `collection.presence<P>()` → `PresenceHandle<P>`. HKDF-derived presence key from DEK. Pub/sub + storage-poll fallback at `_presence_COLLECTION`. |
| #135 | `core/sync.ts` | `db.transaction(comp).put(col, id, rec).delete(col, id).commit()`. Two-phase local write + filtered push. |
| #136 | `packages/yjs/` | New `@noy-db/yjs` package. `yjsCollection(comp, name, { yFields })`, `getYDoc/putYDoc/applyUpdate`, `yText/yMap/yArray` descriptors. |

**Key implementation notes:**
- **CRDT state** stored encrypted in `_data`. `get()` auto-resolves via `decryptRecord`. `getRaw()` returns raw `CrdtState`.
- **RGA tombstones**: stay in `items` array; `tombstones` is the NID filter list.
- **Presence key** = `HKDF(DEK, salt='noydb-presence', info=collectionName)` — `crypto.ts:derivePresenceKey`.
- **`@noy-db/yjs`** stores `base64(Y.encodeStateAsUpdate)` as `crdt: 'yjs'` payload.
- **ESLint**: no inline `import()` type annotations; `as object` after `typeof x === 'object'` is flagged.

---

## Release-time invariants (hard-won — do not skip)

1. **Always use `pnpm release:version`** — never `pnpm changeset version` directly.
2. **Peer deps must be `workspace:*`** not `workspace:^` — prevents changeset pre-1.0 major-bump bug.
3. **New packages need lockfile updates before CI** — `pnpm install` locally, commit lockfile.
4. **Auth branches must rebase onto core branch, not main** when new core barrel exports added.
5. **happy-dom WebCrypto is occasionally flaky** — just re-run the CI job if `auth-oidc` fails.
6. **PR merge order matters** — core PR first, then auth PRs rebased onto updated main.

---

## Build commands

```bash
pnpm install                      # install all workspace deps
pnpm turbo build                  # build all packages
pnpm turbo test                   # run all tests
pnpm turbo lint                   # lint all packages
pnpm turbo typecheck              # typecheck all packages
pnpm vitest run packages/core     # run core tests only
pnpm vitest run -t "session"      # run tests matching pattern

# Release (PAUSED — do not run until npm cleanup + v0.11 rename complete)
pnpm release:version              # bump all packages to core's version
git add . && git commit -m "chore: release vX.Y.Z"
git push origin main && git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
pnpm turbo build && pnpm changeset publish
```

---

## ESLint rules that bite

| Rule | What it requires |
|------|-----------------|
| `@typescript-eslint/no-unused-vars` | Prefix unused vars with `_` |
| `@typescript-eslint/no-explicit-any` | Use `unknown` instead of `any` |
| `@typescript-eslint/no-non-null-assertion` | Avoid `!` — narrow the type |
| `@typescript-eslint/no-unnecessary-type-assertion` | Don't cast when already narrowed |
| `import/no-cycle` | No circular imports |
| `no-restricted-syntax` (inline import) | No `import()` type refs inline — import at top |
