# Issue #196 — feat(on-threat): multi-attempt lockout policy — N wrong passphrases → lock / cooldown / wipe

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · On (@noy-db/on-*)
- **Labels:** type: feature, type: security

---

Configurable policy: after N consecutive wrong passphrases, either (a) time-based cooldown (exponential back-off), (b) permanent lock requiring admin recovery, or (c) data-destruct (wipe the keyring + every envelope). Counter is stored client-side in the envelope metadata, signed by the vault itself so attackers cannot reset it by modifying local state. Explicit opt-in (the data-destruct mode especially).
