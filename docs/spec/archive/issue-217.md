# Issue #217 — feat(core): shadow vaults — read-only preview/presentation mode that cannot write back

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.16.0 — Advanced core features
- **Labels:** type: feature, area: core

---

A "shadow" Noydb instance opened with read-only credentials — syncs from primary but every write path rejects. Use cases: screen-sharing a live vault without exposing edit keys, a presentation mode during demos, a read-only audit session for compliance reviewers. Keyring variant with deks stripped of the wrapping-key half needed for new writes. Shadow vaults are also a natural fit for the hierarchical access model (v0.18) — shadow is the ultimate "lower tier" view.
