# Changelog

## 0.1.0-pre.1 — Initial pre-release

First public pre-release of `noy-db`. Encrypted, offline-first document store with a 6-method storage contract and a small constellation of satellite packages (stores, framework integrations, unlock methods, export formats).

- **Hub** — `@noy-db/hub` is the encrypted document-store core. AES-256-GCM with per-user keys derived via PBKDF2-SHA256 (600K iterations). Stores only ever see ciphertext.
- **Storage destinations** — `@noy-db/to-*` packages: memory, file, browser-idb, browser-local, AWS DynamoDB, AWS S3, Cloudflare R2/D1, Postgres, MySQL, SQLite, Turso, Supabase, WebDAV, SSH, SMB, NFS, iCloud, Google Drive, plus diagnostic / metering wrappers.
- **Framework integrations** — `@noy-db/in-*` packages: Vue, Pinia, Nuxt, React, Next.js, Svelte, Zustand, TanStack Query/Table, Yjs, AI tool-calling.
- **Unlock paths** — `@noy-db/on-*` packages: WebAuthn / passkeys, OIDC, magic-link, recovery codes, Shamir k-of-n, TOTP, email OTP, PIN, threat (lockout/duress/honeypot).
- **Portable artefacts** — `@noy-db/as-*` packages: CSV, XLSX, JSON, NDJSON, XML, SQL dumps, blob, ZIP, encrypted `.noydb` bundle.
- **Session-share transports** — `@noy-db/by-*` family reserved for live-state bridges between realms. `@noy-db/p2p` (WebRTC) ships now and will rename to `@noy-db/by-peer`; `@noy-db/by-tabs` (BroadcastChannel multi-tab sync) lands in a follow-up release.

**Pre-1.0.** Public APIs may evolve based on adopter feedback. No third-party cryptographic audit yet — that is a 1.0 target.

Per-package release notes live in each `packages/<name>/CHANGELOG.md`.
