# Issue #218 — feat(core): consent boundaries — per-access audit log with { actor, purpose, consent_hash }

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.16.0 — Advanced core features
- **Labels:** type: feature, priority: high, area: core, pilot-1

---

Per-collection access logs recording { actor, purpose, consent_hash, timestamp } for every get/put/delete. The consent_hash is hashed (not stored) content of a consent record the actor presented — enabling GDPR Art. 6/7 lawful-basis tracking, HIPAA minimum-necessary, and equivalents, without the access log itself leaking record contents. Query via a new db.consentAudit(filter) surface. Pairs well with hierarchical access (v0.18): cross-tier access logs are consent-boundary entries.
