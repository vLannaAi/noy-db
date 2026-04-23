# Issue #104 — feat(to-drive): @noy-db/to-drive — Google Drive bundle store with OAuth + opaque handles

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-23
- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, area: adapters

---

## Target package

`@noy-db/to-drive` (new)

## Spawned from

Discussion #94 — `@noy-db/to-drive`: Google Drive bundle store. Full OAuth scope / token storage / filename policy rationale in the discussion.

## Problem

Consumer mobile-first deployments — which includes most of Southeast Asia — already have Drive preinstalled, an already-authenticated Google account, and 15 GB of free storage the user already trusts for backups. It's the lowest-friction cloud storage the target audience already has. Drive never sees plaintext (opaque `.noydb` blobs, custom MIME), and Drive's native file revisions provide a free versioning backstop alongside the ledger.

First consumer of the `NoydbBundleStore` shape (#103) and the `.noydb` container format (#100).

## Scope

- **`@noy-db/to-drive` package** implementing `NoydbBundleStore` from #103.
- **OAuth 2.0 with PKCE**, scope restricted to `drive.file` (app-scoped — the store only sees files it created, not the user's full Drive). Never requests broader scopes.
- **Opaque-handle filenames** — files are named `<ULID>.noydb` per the #92 / #100 handle policy. Never `<vault-name>.noydb` — Drive folder listings are visible to share recipients, indexed by Google's account-internal search, and visible to Workspace admins on managed accounts. Naming the file after the vault leaks client identity to all of those surfaces.
- **Optimistic concurrency via Drive file revisions** — Drive's `etag` / `headRevisionId` maps directly onto the bundle store's opaque `version` token.
- **Token storage is consumer-provided** — the store does not persist refresh tokens. Consumer passes a token store interface (same pattern as the existing auth contexts). Defaults ship for browser (`localStorage` wrapped by the existing obfuscation layer) and Node (in-memory, consumer responsible for persistence).
- **Folder structure:**
  ```
  NoyDB/                          ← single folder in appDataFolder OR user-chosen
  ├── 01HXG4F5ZK7QJ8M3R6T9V2W0YN.noydb
  ├── 01HXG4G2A9F0K1P3Q5S7T9V0WX.noydb
  └── ...
  ```
  Default: `appDataFolder` (invisible to the user, cannot be manually deleted from the Drive UI — safer default). Opt-in: user-visible folder for consumers who want the restore UX of \"open Drive, see the file.\"
- **Rate-limit awareness** — exposes remaining quota to the `syncPolicy` from #101 so consumers can backoff on low budget.
- **No plaintext metadata in Drive custom properties** — Drive allows arbitrary key/value metadata on files. The store explicitly does not write anything here. Every piece of metadata about the vault lives inside the encrypted body.
- **`revokeAccess()`** method — deletes the OAuth token locally and optionally calls Drive's revoke endpoint. Consumer UI surfaces this as \"disconnect from Drive.\"

## Non-goals

- **No Drive-specific sync semantics** — scheduling is governed by `syncPolicy` (#101), not hardcoded.
- **No multi-account support in v1** — one Google account per instance. Multi-account is a v2.
- **No Shared Drives support in v1** — personal Drive only.
- **No file-sharing UI** — noy-db's share model is keyring grants, not Drive ACLs.

## Acceptance

- [ ] `@noy-db/to-drive` package implementing `NoydbBundleStore`
- [ ] OAuth 2.0 PKCE flow with `drive.file` scope only
- [ ] Token store interface with browser (obfuscated localStorage) and Node (in-memory) defaults
- [ ] Filenames are always `<ULID>.noydb` — enforced by a test that tries to create a non-ULID name and expects rejection

---
**Naming convention update (2026-04-23):** Renamed from the pre-v0.11 `@noy-db/drive` to the current `@noy-db/to-*` convention. References to `NoydbAdapter`/`NoydbBundleAdapter` updated to `NoydbStore`/`NoydbBundleStore`; `compartment` updated to `vault`.
