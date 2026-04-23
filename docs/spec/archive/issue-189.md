# Issue #189 — feat(in-qwik): @noy-db/in-qwik — resumable queries

- **State:** open
- **Author:** @vLannaAi
- **Created:** 2026-04-21

- **Milestone:** Fork · Integrations (@noy-db/in-*)
- **Labels:** type: feature, priority: low

---

Qwik has unique SSR resumability semantics. A noy-db adapter must respect the server→client handoff (encrypted payload can serialize the state; client picks up without re-decrypting on the server side). Low priority — gated on qwik adoption + team feedback.
