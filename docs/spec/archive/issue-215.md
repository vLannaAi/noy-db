# Issue #215 — feat(core): time-machine queries — db.at(timestamp).collection(...).get(id) via hash-chained ledger

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.16.0 — Advanced core features
- **Labels:** type: feature, area: core

---

Point-in-time reads reconstructed from the ledger history. db.at("2026-03-15T10:00Z").collection("invoices").get("inv-001") returns the record as it existed at that moment. Natural pair with v0.17 period closure: "show me the invoices as they stood at the close of Q1". Builds on the existing LedgerStore + applyPatch primitives. Read-only surface; writes to a point-in-time view throw.
