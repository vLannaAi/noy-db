# @noy-db/create

## 0.5.0

### Initial release

Wizard + CLI tool for `noy-db`. Invoke via `npm create @noy-db` (or the `pnpm` / `yarn` equivalent) to scaffold a fresh Nuxt 4 + Pinia encrypted store, or to patch an existing Nuxt 4 project in place.

**Fresh-project mode.** Prompts for a project name, adapter choice (`browser` / `file` / `memory`), and whether to include sample data. Emits a minimal Nuxt 4 starter with `@noy-db/nuxt` pre-wired, a typed `defineNoydbStore<Invoice>` in `stores/invoices.ts`, and an `index.vue` page that demonstrates reactive reads and writes against the store.

**Augment mode.** Run the wizard from inside an existing Nuxt 4 project root and it detects the project automatically (via `nuxt.config.{ts,js,mjs}` + `package.json`-declared `nuxt` dependency) and patches `nuxt.config.ts` in place using [magicast](https://github.com/unjs/magicast) AST rewriting. Adds `'@noy-db/nuxt'` to the `modules` array, adds `noydb: { adapter, pinia: true, devtools: true }`, preserves unrelated config keys and comments, shows a colored unified diff before any write, and asks for confirmation. Idempotent — re-running on an already-augmented project is a no-op. `--dry-run` prints the diff without writing. `--force-fresh` forces classic fresh-project mode even inside a Nuxt directory.

**Internationalization.** The wizard speaks English and Thai. Pick explicitly with `npm create @noy-db my-app --lang th`, or let the wizard auto-detect from the standard POSIX locale env vars (`LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE`) — a developer who already has `LANG=th_TH.UTF-8` in their shell rc gets Thai automatically with no flag. Validation errors and stack traces stay in English regardless of locale so bug reports are triageable by maintainers who speak either language. Adding a third language is ~30 lines of new code plus a test.

**`noy-db` CLI.** Four subcommands for routine key-management and backup tasks:

- `noy-db verify` — runs the integrity check on a compartment (chain verification + data envelope cross-check).
- `noy-db rotate` — rotates DEKs for one or more collections, re-encrypts every record, and re-wraps the new keys into every user's keyring.
- `noy-db add user <id> <role>` — grants a new user access to a compartment, prompting for the caller's passphrase and then the new user's passphrase.
- `noy-db backup <target>` — dumps a compartment to a local file using the verifiable-backup format. Target accepts `file://` URIs or plain paths. Parent directories are created on demand.

All subcommands use the file adapter, prompt for passphrases via `@clack/prompts` `password()` (never echoes, never logs), and close the `Noydb` instance in a `finally` block to clear the KEK from memory on the way out.

Dependencies: `@clack/prompts`, `picocolors`, `magicast`, `diff`, and the `@noy-db/core`, `@noy-db/memory`, `@noy-db/file` packages at `^0.5.0`.
