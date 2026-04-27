# noy-db specification

> **Status: pre-release placeholder.** A full specification lands with the first stable release. Until then, [`SUBSYSTEMS.md`](./SUBSYSTEMS.md) is the canonical catalog and [`docs/core/`](./docs/core/) describes the always-on surface.

## What ships in 0.1.0-pre.1 — at a glance

- **Hub** (`@noy-db/hub`) — encrypted document store, vault + collection model, 6-method storage contract, query DSL, optional subsystems behind `with*()` strategy seams.
- **Storage** (`@noy-db/to-*`) — 20 backends from in-memory through cloud SQL.
- **Frameworks** (`@noy-db/in-*`) — bindings for Vue / Pinia / Nuxt / React / Next.js / Svelte / Zustand / TanStack / Yjs / AI tool-calling.
- **Unlock** (`@noy-db/on-*`) — passkeys, OIDC, magic-links, recovery codes, Shamir, TOTP, email-OTP, PIN, threat (lockout / duress / honeypot).
- **Export** (`@noy-db/as-*`) — CSV, XLSX, JSON, NDJSON, XML, SQL, blob, ZIP, encrypted `.noydb` bundle.
- **Session-share transports** (`@noy-db/by-*`) — live-state bridges between realms. Today: `@noy-db/p2p` (WebRTC peers; will rename to `@noy-db/by-peer`). Planned: `@noy-db/by-tabs` (BroadcastChannel multi-tab sync), future `by-room` / `by-server` for relayed presence.

## Crypto invariants (frozen)

- Zero crypto dependencies. Everything uses `crypto.subtle`.
- AES-256-GCM with a fresh random 12-byte IV per write. Never reuse IVs.
- PBKDF2-SHA256 with 600,000 iterations for key derivation.
- AES-KW (RFC 3394) for wrapping DEKs with the KEK.
- KEK never persisted. Lives in memory for the duration of an active session.
- Stores only see ciphertext.

## Open for change pre-1.0

- The public TypeScript surface (named exports, option shapes, error classes) may evolve based on pilot feedback.
- The envelope wire format is stable but optional fields may be added.
- Optional subsystem strategies and their option shapes may be renamed or split.
