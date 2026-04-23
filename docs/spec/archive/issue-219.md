# Issue #219 — feat(crypto): deterministic encryption mode — searchable encrypted indexes, opt-in only

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** v0.19.0 — Advanced crypto & privacy
- **Labels:** type: feature, type: security, area: core

---

Replace the random 12-byte IV with HKDF-derived deterministic IV per { DEK, field, record_id }. Same plaintext under the same key produces the same ciphertext — enables exact-match searchable indexes on encrypted fields + blind dedup across vaults. Leaks equality (known side channel of deterministic encryption). Explicit opt-in per-field at schema time; default stays randomised AES-GCM. Ships with a big warning block in the README and a requireAcknowledgeRisks: true option to prevent accidental enablement.
