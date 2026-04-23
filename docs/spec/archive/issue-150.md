# Issue #150 — chore: rename all packages — hub, in-*, to-*

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-10
- **Milestone:** v0.11.0
- **Labels:** _(none)_

---

## Overview

Rename all packages to a consistent taxonomy before the first stable public release. No backward-compat aliases needed — npm history will be cleaned up separately via support ticket.

## New naming convention

| Category | Prefix | Direction |
|---|---|---|
| Core runtime | (none) | — |
| Framework integrations | `in-` | app → noy-db |
| Storage backends | `to-` | noy-db → storage |
| Auth | `auth-` | — |

## Package renames

### Core
| Old | New |
|---|---|
| `@noy-db/core` | `@noy-db/hub` |

### Framework integrations (`in-`)
| Old | New |
|---|---|
| `@noy-db/vue` | `@noy-db/in-vue` |
| `@noy-db/pinia` | `@noy-db/in-pinia` |
| `@noy-db/nuxt` | `@noy-db/in-nuxt` |
| `@noy-db/yjs` | `@noy-db/in-yjs` |

### Storage backends (`to-`)
| Old | New |
|---|---|
| `@noy-db/store-file` | `@noy-db/to-file` |
| `@noy-db/store-memory` | `@noy-db/to-memory` |
| `@noy-db/store-browser-local` | `@noy-db/to-browser-local` |
| `@noy-db/store-browser-idb` | `@noy-db/to-browser-idb` |
| `@noy-db/store-aws-s3` | `@noy-db/to-aws-s3` |
| `@noy-db/store-aws-dynamo` | `@noy-db/to-aws-dynamo` |

### Auth (unchanged)
`@noy-db/auth-webauthn`, `@noy-db/auth-oidc` — no rename needed.

### Scaffolder (unchanged)
`create-noy-db` — no rename needed.

## Scope of changes

- [ ] Rename all `packages/*` directories
- [ ] Update all `package.json` names
- [ ] Update all internal cross-package imports and peerDependencies
- [ ] Update `CLAUDE.md`, `SPEC.md`, `ROADMAP.md`, `HANDOVER.md`
- [ ] Update CI workflows (package paths, names)
- [ ] Update `scripts/release.mjs` exclusion list
- [ ] Verify all 1065+ tests pass after rename

## npm strategy

No `@noy-db/store-*` versions were ever widely consumed — npm cleanup (unpublish + support ticket) will remove all pre-v0.11 history before re-publishing under new names.
