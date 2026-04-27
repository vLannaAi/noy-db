# Roadmap

## What's next on the road to 1.0

- **Pilot adoption + feedback.** First-party adopters running on `0.1.0-pre.x` for at least one full release cycle. Their pain points drive the API decisions that get locked at 1.0.
- **Public API stability gate.** Tag every exported symbol `@public` or `@internal`, wire `@microsoft/api-extractor` (or equivalent) into CI so any unintended surface change blocks merges.
- **Third-party cryptographic audit.** External review of the key hierarchy, envelope format, AES-KW wrapping, and PBKDF2 parameters. Required before a 1.0 stamp.
- **Bundle-size CI gate.** Pin the floor + per-subsystem allowances in `bundle-manifest.json`; CI fails on any unexplained regression.
- **Showcase + recipe coverage.** A runnable end-to-end test for every `with*()` strategy and every storage destination so adopters pick a backend by reading working code.
- **`by-*` session-share family.** Land `@noy-db/by-tabs` (BroadcastChannel multi-tab sync) and rename `@noy-db/p2p` → `@noy-db/by-peer` so the WebRTC transport joins the same family. The naming pattern (`to-` / `in-` / `on-` / `as-` / `by-`) becomes the full mental model.

No version-numbered milestones until `0.1.0` — the pre-release is intentionally a single rolling target.

Tracking issues live on GitHub. The catalog of subsystems and packages is in [`SUBSYSTEMS.md`](./SUBSYSTEMS.md) and [`docs/packages/`](./docs/packages/).
