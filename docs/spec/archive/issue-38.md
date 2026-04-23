# Issue #38 — noy-db CLI: rotate, seed, backup, add user subcommands

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-07
- **Milestone:** v0.5.0
- **Labels:** type: feature, priority: high, area: scaffolder, release: v0.5

---

Deferred from #9. Add four new subcommands to the noy-db bin: rotate (interactive key rotation), seed (re-run scripts/seed.ts), backup <uri> (one-shot encrypted backup, file:// + s3://), add user <id> <role> (keyring grant). Each needs a CLI auth story (passphrase prompt, never log, clear from memory). Exit codes: 0/1/2/3. Estimate: L.
