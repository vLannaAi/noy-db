# Issue #214 — feat(p2p): @noy-db/p2p — WebRTC peer-to-peer sync (no server in the middle)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** v0.20.0 — Edge & realtime
- **Labels:** type: feature, area: core

---

Direct browser-to-browser sync via WebRTC data channels. Signaling can be anything (Matrix, paste-a-code, QR-based handshake). TURN fallback only sees ciphertext. Maps to SyncTarget with role: sync-peer but the transport is WebRTC instead of a NoydbStore. Forwarded from the v1.x roadmap because the first pilot projects want it. Prototype should work peer-to-peer on a LAN first; multi-peer mesh topology is a follow-up.
