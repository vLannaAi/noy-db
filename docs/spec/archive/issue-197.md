# Issue #197 — feat(on-threat): duress passphrase — data-destruct mode

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · On (@noy-db/on-*)
- **Labels:** type: feature, type: security

---

Register a second "duress" passphrase at setup. If ever typed, the vault instantly and irrecoverably wipes itself: keyring erased, all envelopes zeroed, even the ledger is cleared. Use case: coercion resistance. The user types the duress passphrase under threat, hands over an empty vault, attacker walks away with nothing. Should integrate with on-threat-lockout (a duress-pass attempt also trips the counter on the real passphrase, hiding the destruct behaviour). Explicit opt-in with heavy warnings.
