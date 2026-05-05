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

- **Per-principal user envelope (`vault.user.*`, v0.1.0-pre.6).** Every keyring gets a `_users/<keyringId>` envelope encrypted under a shared `_users` DEK; hub owns plumbing (storage, sync, history, lifecycle, encryption), apps own schema. Three method families: write-self (`me/updateMe/setMe` — own-only write rule, structural), read-anyone (`get/list` gated by `view-team-profiles`), reactive (`subscribe/live`). New built-in policy gates `edit-own-profile` (default `minTier: 3`) and `view-team-profiles` (default `minTier: 2`). `db.grant({ initialProfile: T })` admin pre-fill at invite time; cascade-revoke deletes envelopes alongside keyrings. Joined enumeration via `listUsersWithEnvelopes()` for admin UIs. See `docs/subsystems/user-envelope.md`.
- **`db.enrollWebAuthn()` and `db.lockVault()` (v0.1.0-pre.6).** Two infrastructure unblockers for the niwat consumer: native WebAuthn enrollment with the real internal keyring (no synthetic-keyring workaround), and a soft-lock that preserves QuickUnlock state (PIN resume after lock-screen UX).
- **Vault diff utility** (`diffVault`) — primitive  used by every `as-*` reader and any consumer-side preview UI.
- **Slice export of `.noydb` bundles** — `collections` allowlist + `since` envelope cutoff.
- **Multi-recipient re-keyed `.noydb` bundles** — `exportPassphrase` shorthand and `recipients[]` with per-slot ACL.
- **Import family phase 1** — `fromString` / `fromBytes` for `as-csv` / `as-json` / `as-ndjson` / `as-zip`, returning an `ImportPlan` with `merge | replace | insert-only` policies.
- **WinZip-AES-256 password on `as-zip`** — implementation strictly to spec; cross-tool interop validation pending.
- **Import family phase 2** — `as-blob` `fromBytes`, `as-xml` `fromString`, `as-xlsx` `fromBytes` reader; symmetric with phase 1 ImportPlan shape.
- **Import capability gate** — `ImportCapability` keyring extension + `vault.assertCanImport(tier, format?)`. Default-closed for every role on every dimension; owners must positively grant.
- **Atomic apply** — `ImportPlan.apply()` inside `vault.noydb.transaction(...)`. Partial failure rolls back via `runTransaction`'s revert pass; opt-in via `withTransactions()` strategy.
- **Per-recipient bundle expiry** — `recipients[].expiresAt`. Past-cutoff slot throws `KeyringExpiredError` before DEK unwrap (no passphrase-timing leak).
- **Bundle record-level filters** — `where` predicate and `tierAtMost` ceiling on `writeNoydbBundle`. Plaintext pre-pass; survivors carry their original ciphertext (no re-encrypt, zero-knowledge clean).

Deferred sub-issues open at `priority: low` for the next cycle:
- ledger-aware slice (drops collection cleanly when history is on) — **blocked on design RFC**: refuse-when-history-present vs allow-divergent-head with `slicedFrom` metadata
- per-import ledger-entry tagging (`reason: 'import:<format>'`) — scope larger than initial estimate; needs `LedgerEntry` shape change + `Collection.put` option threading + canonical-JSON hash chain test pin
- WinZip-AES interop validation matrix against 7-Zip / Archive Utility / WinRAR — manual cross-tool testing, not a code task

No version-numbered milestones until `0.1.0` — the pre-release is intentionally a single rolling target.

Tracking issues live on GitHub. The catalog of subsystems and packages is in [`SUBSYSTEMS.md`](./SUBSYSTEMS.md) and [`docs/packages/`](./docs/packages/).
