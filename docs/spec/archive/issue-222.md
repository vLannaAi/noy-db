# Issue #222 — feat(crypto): zero-knowledge proofs for compliance — prove properties without revealing values

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** v0.19.0 — Advanced crypto & privacy
- **Labels:** type: feature, type: security, area: core

---

Ship a zk-SNARK-based proof primitive: "prove I hold ≥ N records in collection X matching predicate P without revealing the records or N itself". Concrete use case: a regulated accounting firm proves solvency ratios to an auditor without disclosing individual receivables; a clinic proves headcount thresholds for insurance compliance without disclosing patient lists. Gated by a real external use case — design + ship only when an adopter asks. Likely depends on circomlib / noir / halo2 (decision TBD). From v2.0 roadmap; file now as parking-lot issue for design discussion.
