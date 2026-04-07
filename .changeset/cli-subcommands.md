---
"@noy-db/create": minor
"@noy-db/core": minor
---

Add three new `noy-db` subcommands for routine key-management and backup tasks (closes #38):

- **`noy-db rotate`** — rotate DEKs for one or more collections in a compartment. Generates fresh keys, re-encrypts every record, and re-wraps the new keys into every user's keyring. Unlike `revoke({ rotateKeys: true })`, nobody is removed — everyone keeps their current permissions with fresh key material.

- **`noy-db add user <id> <role>`** — grant a new user access to a compartment. Prompts for the caller's passphrase, then the new user's passphrase (confirmed). `operator` and `client` roles require an explicit `--collections invoices:rw,clients:ro` flag.

- **`noy-db backup <target>`** — dump a compartment to a local file. As of v0.4, `dump()` already produces a verifiable backup (embedded ledger head, full `_ledger` / `_ledger_deltas` snapshots), so the CLI is a thin wrapper: it prompts for the passphrase, opens the compartment, calls `dump()`, and writes the result. Target accepts `file://` URIs or plain paths. Parent directories are created on demand.

```bash
noy-db rotate    --dir ./data --compartment demo-co --user owner-alice
noy-db add user  accountant-ann operator \
                 --dir ./data --compartment demo-co --user owner-alice \
                 --collections invoices:rw,clients:ro
noy-db backup    ./backups/demo-2026-04-07.json \
                 --dir ./data --compartment demo-co --user owner-alice
```

All three subcommands:
- Use the file adapter (CLI is for filesystem-based workflows)
- Prompt for the passphrase via `@clack/prompts` `password()` (never echoes, never logs)
- Accept dependency injection for the passphrase reader, Noydb factory, and adapter — so tests run synchronously without touching stdin or disk
- Close the Noydb instance in a `finally` block to clear the KEK from memory on the way out

### `@noy-db/core` additions

- New `Noydb.rotate(compartment, collections)` method — the "just rotate" path. Previously rotation was only available bundled with `revoke({ rotateKeys: true })`, which also kicked a user out. The new method rotates keys without removing anyone; the CLI `rotate` subcommand uses it.

### What's NOT in this PR

- **`noy-db seed`** — needs a design decision about how user-supplied seed scripts authenticate to the compartment. Deferred.
- **S3 backup targets** — would bundle `@aws-sdk` into `@noy-db/create`, defeating the zero-deps story. A separate companion package can handle this.
- **`restore`** — paired with a future "verify signed backup on load" flow.
- **Session-based auth** — every subcommand re-prompts for the passphrase. Session tokens are tracked as part of the v0.5 epic itself.

### Tests

- **15 new tests** in `packages/create-noy-db/__tests__/subcommands.test.ts` covering:
  - `rotate` — auto-detect collections, explicit list, post-rotate decrypt still works, wrong passphrase rejected
  - `addUser` — owner path, operator with permissions, operator without permissions rejected, confirmation mismatch rejected, wrong caller passphrase rejected, newly granted user can unlock
  - `backup` — verifiable backup written to disk, parent directories created on demand, `file://` URI accepted, `s3://` / `https://` rejected, wrong passphrase leaves no file
- Full monorepo turbo pipeline: 51/51 tasks green
- All 376 existing core tests still pass

Closes #38, part of v0.5.0.
