# Issue #151 — feat(cli): .noydb reader CLI — inspect, open, verify

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-21
- **Milestone:** v0.13.0 — Developer tools (P1)
- **Labels:** type: feature

---

Split from #102.

## Target package

`@noy-db/cli` — extends the existing CLI with reader subcommands.

## Commands

- **`noydb inspect <file.noydb>`** — prints unencrypted header only (handle, format version, body size, SHA256). Never prompts for passphrase. Never decrypts.
- **`noydb open <file.noydb>`** — interactive REPL against the vault. Prompts for passphrase. Read-only by default.
- **`noydb open <file.noydb> --query '<expr>'`** — non-interactive query mode. Passphrase from `$NOYDB_PASSPHRASE` or stdin. Prints JSON.
- **`noydb open <file.noydb> --rw`** — mutable mode, syncs changes back to file on close with confirmation prompt.
- **`noydb verify <file.noydb>`** — header SHA + body SHA + ledger head check. Passphrase required only for ledger check.

All commands consume `readNoydbBundle()` / `readNoydbBundleHeader()` from `@noy-db/hub`. No separate reader logic in the CLI.

## Acceptance

- [ ] `inspect` never prompts for passphrase, never decrypts, prints header JSON
- [ ] `open --query` reads passphrase from env or stdin, prints JSON result
- [ ] `open --rw` requires explicit confirmation before writing back
- [ ] Integration tests against sample bundles
- [ ] Changeset for `@noy-db/cli`
- [ ] Docs: `docs/reader.md` (CLI section)

## Related

- #100 — `.noydb` container format (blocks this)
- #102 — original combined issue (closed, split here + new browser extension issue)
- Discussion #96 — PWA-vs-extension rationale
