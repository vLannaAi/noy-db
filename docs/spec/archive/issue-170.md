# Issue #170 — Showcase 05: Blob Document Lifecycle (Node.js)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-11
- **Closed:** 2026-04-20
- **Milestone:** Showcases
- **Labels:** showcases

---

## 05-blob-document-lifecycle.showcase.ts — "Upload, Version, Share"

**Framework:** Node.js (pure hub) | **Store:** `memory()` | **Branch:** `showcase/05-blob-lifecycle`

### Flow
- Put invoice → `blob('inv-001').put('receipt', pdfBytes)`
- `blob.list()` → `blob.get()` exact bytes
- `blob.publish('v1')` → modify → `blob.publish('v2')`
- `blob.versions()` shows both; `getVersion('v1') ≠ 'v2'`
- `blob.response('receipt')` returns proper Content-Type

**Goal:** Show noy-db as a full document store.
**Dimension:** Document store, blob attachments, versioning
