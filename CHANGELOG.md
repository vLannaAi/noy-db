# Changelog

## 0.1.0-pre.1 — Initial pre-release

First public pre-release of `noy-db`. Encrypted, offline-first document store with a 6-method storage contract and a small constellation of satellite packages (stores, framework integrations, unlock methods, export formats).

- **Hub** — `@noy-db/hub` is the encrypted document-store core. AES-256-GCM with per-user keys derived via PBKDF2-SHA256 (600K iterations). Stores only ever see ciphertext.
- **Storage destinations** — `@noy-db/to-*` packages: memory, file, browser-idb, browser-local, AWS DynamoDB, AWS S3, Cloudflare R2/D1, Postgres, MySQL, SQLite, Turso, Supabase, WebDAV, SSH, SMB, NFS, iCloud, Google Drive, plus diagnostic / metering wrappers.
- **Framework integrations** — `@noy-db/in-*` packages: Vue, Pinia, Nuxt, React, Next.js, Svelte, Zustand, TanStack Query/Table, Yjs, AI tool-calling.
- **Unlock paths** — `@noy-db/on-*` packages: WebAuthn / passkeys, OIDC, magic-link, recovery codes, Shamir k-of-n, TOTP, email OTP, PIN, threat (lockout/duress/honeypot).
- **Portable artefacts** — `@noy-db/as-*` packages: CSV, XLSX, JSON, NDJSON, XML, SQL dumps, blob, ZIP, encrypted `.noydb` bundle.
- **Session-share transports** — `@noy-db/by-*` family for live-state bridges between realms. `@noy-db/by-peer` (WebRTC peer-to-peer) and `@noy-db/by-tabs` (BroadcastChannel multi-tab sync) ship today; `by-server` and `by-room` are reserved for follow-up releases. The `@noy-db/p2p` package was renamed to `@noy-db/by-peer` to fit the family.
- **Vault diff utility** — `diffVault(vault, candidate, options?)` exported from `@noy-db/hub`. Walks two whole vaults (or a vault vs JSON candidate) and returns an added / modified / deleted plan with field-level diffs on modified rows. Builds on the per-record `history/diff.ts` helper (#303).
- **`.noydb` bundle slice + re-keying** — `WriteNoydbBundleOptions` accepts `collections` allowlist, `since` envelope cutoff, and either `exportPassphrase` (single-recipient shorthand) or `recipients[]` (multi-recipient). Each recipient slot is a portable keyring sealed with its own passphrase, with per-collection ACL and optional role; record ciphertext stays unchanged across re-keying (#301).
- **Import family — phase 1** — `fromString` / `fromBytes` for `@noy-db/as-csv`, `@noy-db/as-json`, `@noy-db/as-ndjson`, and `@noy-db/as-zip`. Each returns an `ImportPlan` with three reconciliation policies (`merge`, `replace`, `insert-only`). Preview is via `diffVault`; `apply()` writes through the normal collection API (#302 phase 1).
- **`as-zip` WinZip-AES-256 password** (experimental) — opt-in `password` option encrypts every entry with WinZip-AES-256 (vendor version AE-2). Strictly to spec; cross-tool interop validation against 7-Zip / Archive Utility / WinRAR is pending (#304, #312). README carries the experimental warning until the matrix lands.

**Pre-1.0.** Public APIs may evolve based on adopter feedback. No third-party cryptographic audit yet — that is a 1.0 target.

Per-package release notes live in each `packages/<name>/CHANGELOG.md`.
