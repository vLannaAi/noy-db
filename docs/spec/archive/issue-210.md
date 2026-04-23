# Issue #210 — feat(audit): real-time notification on cross-tier access + logging

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** v0.18.0 — Hierarchical access levels
- **Labels:** type: feature, area: core

---

Every access to a record above the users inherent tier (via delegation or elevation) fires a change-event with { actor, record, tier, authorization, timestamp }. Consumers can subscribe to stream these to Slack / email / a custom audit sink. Events are always written to the ledger regardless of notification subscription.
