# Issue #230 — refactor(hub/store): group document-storage code into packages/hub/src/store/

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.15.1 — Hub refactor (backward-compat)
- **Labels:** type: feature, area: core

---

Move document-storage-related files into `packages/hub/src/store/` subdirectory. Files to move: `route-store.ts`, `store-middleware.ts`, `bundle-store.ts`, `sync-policy.ts`, `blob-set.ts`, `attachments.ts` (legacy), `mime-magic.ts`, plus the NoydbStore / store-capability types from `types.ts`. Barrel index re-exports from both `packages/hub/src/index.ts` (preserved) AND the new `packages/hub/src/store/index.ts` (new subpath entry).

Rationale: isolates the storage plumbing so v1.x can extract it as `@noy-db/hub-store` if desired, and enables bundlers to tree-shake the ~6–8 KB of routing/middleware code for apps that do not use routeStore/wrapStore.
