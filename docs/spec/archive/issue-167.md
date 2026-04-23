# Issue #167 — Showcase 02: Multi-user Access (Node.js)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-11
- **Closed:** 2026-04-20
- **Milestone:** Showcases
- **Labels:** showcases

---

## 02-multi-user-access.showcase.ts — "Grant, Work, Revoke"

**Framework:** Node.js (pure hub) | **Store:** `memory()` | **Branch:** `showcase/02-multi-user-access`

### Flow
- Owner creates vault + DEKs → grant operator (invoices: rw)
- Operator writes invoices ✓ → operator reads payments ✗
- Owner revokes with `rotateKeys: true` → old DEK fails to decrypt
- Owner still reads everything ✓

**Goal:** End-to-end zero-knowledge access control proof.
**Dimension:** Security, access control, key rotation
