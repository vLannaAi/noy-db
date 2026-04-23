# Issue #182 — feat(to-ipfs): @noy-db/to-ipfs — content-addressed bundle store

- **State:** open
- **Author:** @vLannaAi
- **Created:** 2026-04-21

- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, priority: low, area: adapters

---

Content-addressing is a natural fit for noy-db bundles (the hash-chained ledger already produces SHA256 roots). Export a vault to IPFS as a named pin; subsequent pulls verify by root hash. Use helia (js-ipfs successor).
