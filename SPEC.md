# noy-db specification

> **Status: pre-release placeholder.** A full specification lands with the first stable release. Until then, [`SUBSYSTEMS.md`](./SUBSYSTEMS.md) is the canonical catalog and [`docs/core/`](./docs/core/) describes the always-on surface.

## What ships in 0.1.0-pre.1 — at a glance

- **Hub** (`@noy-db/hub`) — encrypted document store, vault + collection model, 6-method storage contract, query DSL, optional subsystems behind `with*()` strategy seams.
- **Storage** (`@noy-db/to-*`) — 20 backends from in-memory through cloud SQL.
- **Frameworks** (`@noy-db/in-*`) — bindings for Vue / Pinia / Nuxt / React / Next.js / Svelte / Zustand / TanStack / Yjs / AI tool-calling.
- **Unlock** (`@noy-db/on-*`) — passkeys, OIDC, magic-links, recovery codes, Shamir, TOTP, email-OTP, PIN, threat (lockout / duress / honeypot).
- **Export** (`@noy-db/as-*`) — CSV, XLSX, JSON, NDJSON, XML, SQL, blob, ZIP, encrypted `.noydb` bundle. **Import side** (`fromString` / `fromBytes`) ships for CSV, JSON, NDJSON and ZIP — returns an `ImportPlan` whose `apply()` writes through the normal collection API. Three reconciliation policies: `merge` (default), `replace`, `insert-only`.
- **Session-share transports** (`@noy-db/by-*`) — live-state bridges between realms. `@noy-db/by-peer` (WebRTC peers) and `@noy-db/by-tabs` (BroadcastChannel multi-tab) ship today; `by-server` (WebSocket / SSE relay) and `by-room` (Liveblocks / Yjs y-websocket) are reserved.

## Bundle re-keying — multi-recipient `.noydb` (#301)

`writeNoydbBundle()` accepts `exportPassphrase` (single-recipient shorthand) or `recipients[]` (multi-recipient). Each recipient becomes its own keyring slot inside the bundle, sealed with an independent passphrase, with per-collection ACL and an optional role. DEKs are unwrapped from the source keyring once and re-wrapped per recipient — record ciphertext is unchanged.

The recipient-list shape is structurally a portable keyring (`Record<userId, KeyringFile>`), so adding a new recipient family is one schema field, not a new primitive.

## Vault diff utility (#303)

`diffVault(vault, candidate, options?)` walks two whole vaults (or vault vs JSON candidate) and returns a `VaultDiff` plan with added / modified / deleted buckets. Modified entries carry per-field diffs via the existing `history/diff.ts` helper. Reusable by every `as-*` reader and by any consumer-side preview UI.

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
