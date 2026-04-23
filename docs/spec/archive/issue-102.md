# Issue #102 — feat(cli+ext): .noydb reader — CLI commands + browser extension (not PWA)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-10
- **Milestone:** v0.12.0
- **Labels:** type: feature

---

## Target packages

`@noy-db/cli` (extends the existing CLI, adds reader commands), `@noy-db/extension-chrome` (new)

## Spawned from

Discussion #96 — Reader: ship as CLI extension + browser extension (not PWA). Full PWA-vs-extension trade-off rationale in the discussion.

## Problem

Once the `.noydb` container format (#100, v0.6) and bundle adapters (v0.11) exist, users need a way to **open a `.noydb` file** without integrating noy-db into an application. The reader is the missing operational surface: auditors receiving an export, users restoring a backup on a fresh machine, sysadmins verifying a bundle before handing it off.

PWAs are the wrong shape for this: inconsistent File Handling API support (Chromium-only), hosting infrastructure requirement, single point of compromise for the reader UX. The right answer is two local extensions sharing the same core primitive.

## Scope

### Part 1 — CLI reader (`@noy-db/cli`)

Extends the existing CLI with reader-specific commands:

- **`noydb inspect <file.noydb>`** — prints the unencrypted header only (handle, format version, body size, SHA256). Never prompts for passphrase. Never decrypts.
- **`noydb open <file.noydb>`** — interactive. Prompts for passphrase, opens a REPL against the compartment. Read-only by default.
- **`noydb open <file.noydb> --query '<expr>'`** — non-interactive query mode. Passphrase from `$NOYDB_PASSPHRASE` or stdin. Prints JSON.
- **`noydb open <file.noydb> --rw`** — mutable mode, syncs changes back to the file on close with a confirmation prompt.
- **`noydb verify <file.noydb>`** — header SHA + body SHA + ledger head check. No passphrase required for the first two; passphrase required for the ledger check.

All commands consume the same `readNoydbBundle()` / `readNoydbBundleHeader()` primitives from `@noy-db/core` (#100). No separate reader logic lives in the CLI.

### Part 2 — Browser extension (`@noy-db/extension-chrome`)

- **File association** — intercepts `.noydb` file links (via `chrome.runtime.onMessageExternal` + file-drop handler on a built-in page).
- **Drag-and-drop reader page** — user drops a `.noydb` file onto the extension's page, provides passphrase, gets an in-browser read-only view of the compartment.
- **No file upload, ever** — the file is read locally via `FileReader`, decrypted in-memory, never touches the network. The extension has no host permissions.
- **Chromium-first**, Firefox/Safari ports tracked as separate issues if demand materializes.
- **Shared core** — same `readNoydbBundle()` primitive as the CLI. The browser extension bundles `@noy-db/core` + a minimal Vue/Vanilla UI.

### Part 3 — Non-goals

- **No hosted PWA** — rationale in the discussion.
- **No editing in the browser extension v1** — read-only. An edit mode can follow when the core primitives are stable.
- **No Firefox / Safari ports in v1** — tracked separately.
- **No DRM, no watermarking, no access logging** — the reader is a local tool, not a gated distribution platform.

## Acceptance

- [ ] `@noy-db/cli` package exposes `inspect`, `open`, `verify` subcommands backed by `@noy-db/core` bundle primitives
- [ ] `noydb inspect` never prompts for passphrase, never decrypts, prints header JSON only
- [ ] `noydb open --query` reads passphrase from env or stdin, prints JSON result
- [ ] `noydb open --rw` requires explicit confirmation before writing back
- [ ] `@noy-db/extension-chrome` package with manifest v3, no host permissions, drag-and-drop reader page
- [ ] Browser extension uses `FileReader` — no network I/O in the reader code path (enforced by test + manifest review)
- [ ] Shared reader logic lives in `@noy-db/core`, not duplicated between CLI and extension
- [ ] Integration tests for CLI commands against sample bundles
- [ ] Changesets for both packages
- [ ] Docs: `docs/reader.md` covering both surfaces

## Invariant compliance

- [x] No crypto dependencies added — consumes `@noy-db/core` primitives
- [x] No plaintext leaves the local process — extension has no network permissions
- [x] Header inspection reveals no business metadata (enforced by #100)

## Related

- #100 — `.noydb` container format (blocks this)
- Discussion #96 (source)
- Discussion #93 — bundle adapter shape (sibling)

v0.10.0.
