# Issue #220 — feat(on-shamir): @noy-db/on-shamir — k-of-n secret-sharing of the KEK for multi-party unlock

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** Fork · On (@noy-db/on-*)
- **Labels:** type: feature, type: security, priority: high, pilot-1

---

Split the KEK into N shares using Shamir Secret Sharing (well-studied, implementable in pure Web Crypto + small numeric library). Any K of the N shares recombines into the original KEK; fewer than K leaks zero bits. Use cases: "any 2 of 3 admins must authorise an audit-record export", "CEO vault requires CFO + COO consent". Ships enrol/unlock functions matching the on-oidc / on-webauthn package shape (so it composes with them — Shamir share #1 could be a WebAuthn-unlocked store, share #2 an OIDC-unlocked store, etc.).
