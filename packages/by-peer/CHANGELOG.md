# Changelog — by-peer

## 0.1.0-pre.4

### Bug fixes

- **Leader election for `servePeerStore`** ([#3](https://github.com/vLannaAi/noy-db/issues/3)) — when 3+ tabs share a `BroadcastChannel`-backed `PeerChannel` and each runs `servePeerStore`, every non-sending tab responded to every RPC, producing duplicate responses and `O(N²)` channel traffic. Added an opt-in `leaderElection: { lockName, locks? }` option that wraps RPC handler registration in a Web Locks API acquisition — only the lock-holding tab serves; others queue and take over when the holder closes (lock auto-releases). The 2-tab case is unchanged (`BroadcastChannel` doesn't echo to sender), so this is fully backward-compatible. Browser support: Chrome 69+, Firefox 96+, Safari 15.4+. Tests + non-browser hosts can pass a `MinimalLockManager` stub via `leaderElection.locks`.
