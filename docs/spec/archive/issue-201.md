# Issue #201 — feat(ledger): period closure — seal records as closed accounting period, immutable after close

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.17.0 — Time partitioning & auditing
- **Labels:** type: feature, priority: high, area: core, pilot-1

---

vault.closePeriod({ name: "FY2026-Q1", endDate: "2026-03-31" }). After close, every record tagged to that period becomes write-locked (put returns READ_ONLY). The period itself is a named ledger entry (hash-chained to the prior period), so the audit trail proves "nothing after close".
