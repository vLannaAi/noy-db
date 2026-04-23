# Issue #193 — feat(on-recovery): @noy-db/on-recovery — one-time recovery codes

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** Fork · On (@noy-db/on-*)
- **Labels:** type: feature, type: security, priority: high, pilot-1

---

Generate N (default 10) single-use recovery codes at enrolment time. Each code unlocks the vault once and then burns itself. Designed to be printed on paper and stored in a safe. Format: Base32 chunks, human-transcribable. Uses the same wrap-payload pattern as on-webauthn (each code derives a wrapping key via PBKDF2).
