# Milestone 23 — v0.15.1 — Hub refactor (backward-compat)

- **State:** closed
- **Open issues:** 0
- **Closed issues:** 7
- **Due:** _(none)_
- **Created:** 2026-04-21
- **URL:** https://github.com/vLannaAi/noy-db/milestone/23

---

Backward-compatible patch-level refactor of @noy-db/hub internals. Reorganize files into thematic subdirectories (hub/src/store/, hub/src/i18n/, hub/src/team/, hub/src/session/, hub/src/ledger/, hub/src/query/) and add subpath exports (@noy-db/hub/store, /i18n, /team, /session, /ledger, /query) as ADDITIVE opt-ins. Main-entry barrel stays intact — no import breaks for the 3 pilot adopters. Tree-shaking wins for consumers that opt into subpath imports; future v0.16 or v1.0 can drop the main-entry re-exports to force the cleaner interface.

Complements v0.15 Pre-distribution with any small adoption-feedback items surfaced in the first weeks of pilot use. Future adoption patches land as v0.15.2, v0.15.3, … — no ceiling.
