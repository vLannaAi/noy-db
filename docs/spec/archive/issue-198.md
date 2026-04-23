# Issue #198 — feat(on-threat): duress passphrase — honeypot vault (deceptive decoy data)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · On (@noy-db/on-*)
- **Labels:** type: feature, type: security

---

Alternative to data-destruct: the duress passphrase unlocks a honeypot vault with convincing-but-fake data pre-seeded by the user. Under coercion, user types duress pass, attacker sees a plausible-looking but useless vault, user walks away apparently cooperative. Implementation: two distinct keyrings wrap the same underlying adapter; the duress keyring points at a separate set of collection DEKs over fake records. The attacker cannot distinguish real vs honeypot without the real passphrase. Explicit opt-in; UX design for seeding realistic decoys is its own design doc.
