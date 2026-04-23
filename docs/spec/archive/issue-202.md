# Issue #202 — feat(ledger): period opening — carry-forward balances for new period

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.17.0 — Time partitioning & auditing
- **Labels:** type: feature, priority: high, area: core, pilot-1

---

Opening a period computes carry-forward aggregates (e.g. closing balances from previous period) and writes them as opening entries in the new period. Designed to mirror real accounting practice — once Q1 is closed, Q2 opens with Q1 endings as its starting point. Hash-chained to the prior closure so audits can trace back.
