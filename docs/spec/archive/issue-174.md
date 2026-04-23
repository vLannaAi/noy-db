# Issue #174 — Showcase 09: Encrypted CRDT (Yjs)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-11
- **Closed:** 2026-04-20
- **Milestone:** Showcases
- **Labels:** showcases

---

## 09-encrypted-crdt.showcase.ts — "Encrypted Collaboration"

**Framework:** Yjs (`yjsCollection`, `yText`, `yMap`) | **Store:** `memory()` | **Branch:** `showcase/09-encrypted-crdt`

### Flow
- `yjsCollection(vault, 'notes', { yFields: { body: yText(), meta: yMap() } })`
- Insert Thai text → `putYDoc` → verify raw envelope is ciphertext
- Reload → `getText('body') === 'สวัสดี'`
- Two concurrent edits → Yjs CRDT merge → encrypted round-trip

**Goal:** CRDT collaborative editing through encryption layer.
**Dimension:** Security + collaboration, Yjs interop
