# Roadmap

## What's next on the road to 1.0

- **Pilot adoption + feedback.** First-party adopters running on `0.1.0-pre.x` for at least one full release cycle. Their pain points drive the API decisions that get locked at 1.0.
- **Public API stability gate.** Tag every exported symbol `@public` or `@internal`, wire `@microsoft/api-extractor` (or equivalent) into CI so any unintended surface change blocks merges.
- **Third-party cryptographic audit.** External review of the key hierarchy, envelope format, AES-KW wrapping, and PBKDF2 parameters. Required before a 1.0 stamp.
- **Bundle-size CI gate.** Pin the floor + per-subsystem allowances in `bundle-manifest.json`; CI fails on any unexplained regression.
- **Showcase + recipe coverage.** A runnable end-to-end test for every `with*()` strategy and every storage destination so adopters pick a backend by reading working code.
- **`by-*` session-share family.** `@noy-db/by-peer` (WebRTC, renamed from `@noy-db/p2p`) and `@noy-db/by-tabs` (BroadcastChannel multi-tab sync) shipped together with the family debut. Next: `@noy-db/by-server` (WebSocket / SSE relay) and `@noy-db/by-room` (Liveblocks / Yjs y-websocket).

## Recently shipped (and what's deferred)

The following capabilities are now in main:

- **Vault diff utility** (`diffVault`) — primitive #303 used by every `as-*` reader and any consumer-side preview UI.
- **Slice export of `.noydb` bundles** — `collections` allowlist + `since` envelope cutoff (#301 partial).
- **Multi-recipient re-keyed `.noydb` bundles** — `exportPassphrase` shorthand and `recipients[]` with per-slot ACL (#301).
- **Import family phase 1** — `fromString` / `fromBytes` for `as-csv` / `as-json` / `as-ndjson` / `as-zip`, returning an `ImportPlan` with `merge | replace | insert-only` policies (#302 phase 1).
- **WinZip-AES-256 password on `as-zip`** — implementation strictly to spec; cross-tool interop validation pending (#304, #312).

Deferred sub-issues open at `priority: low` for the next cycle:
- `where` / `tierAtMost` plaintext-access bundle filters (#305)
- per-recipient `expiresAt` keyring extension (#306)
- ledger-aware slice (drops collection cleanly when history is on) (#307)
- `ImportCapability` + `vault.assertCanImport` (#308)
- `ImportPlan.apply()` inside `runTransaction` boundary (#309)
- per-import ledger-entry tagging (`reason: 'import:<format>'`) (#310)
- `as-xlsx` / `as-xml` / `as-blob` readers (#311)
- WinZip-AES interop validation matrix against 7-Zip / Archive Utility / WinRAR (#312)

No version-numbered milestones until `0.1.0` — the pre-release is intentionally a single rolling target.

Tracking issues live on GitHub. The catalog of subsystems and packages is in [`SUBSYSTEMS.md`](./SUBSYSTEMS.md) and [`docs/packages/`](./docs/packages/).
