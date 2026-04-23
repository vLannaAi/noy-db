# Issue #227 — docs(api-audit): decide auth- vs on- prefix for authentication packages — consistency audit + migration plan

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.15.0 — Pre-distribution & documentation (P3)
- **Labels:** type: feature, area: core

---

The current naming landscape: in-* (integrations), to-* (storage destinations), auth-* (login providers). A consistent rename would be on-* (short, parallel to in-/to-, reads as "log-on"). Decision blocks on: (a) breaking change for v0.7-shipped auth-webauthn + auth-oidc + any dependent showcases / docs / tests (~200 references), (b) whether v0.15 Pre-distribution is the right window to absorb the churn (probably yes — npm is empty, docs are being rewritten anyway, only 3 known consumers). Deliverable: a decision doc + full search-replace plan + PR that flips the name if the decision is YES.
