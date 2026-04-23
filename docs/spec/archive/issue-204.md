# Issue #204 — showcase: audit trail — cross-period hash-chain verification

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-22
- **Milestone:** v0.17.0 — Time partitioning & auditing
- **Labels:** showcases

---

Showcase: verifyLedger() walks every period seal since vault creation, confirms each period is hash-chained to its predecessor, surfaces any tampering. A failing case seeded by deliberate ledger corruption to prove the verification catches it.
