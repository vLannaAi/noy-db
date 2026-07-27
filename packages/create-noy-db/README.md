# create-noy-db

Wizard + CLI tool for [noy-db](https://github.com/vLannaAi/noy-db) — scaffold a fresh Nuxt 4 + Pinia encrypted store, augment an existing Nuxt project, or run operational commands (add user, rotate keys, backup) from the command line.

Two bins ship in this package:

- **`create-noy-db`** — invoked by `npm create noy-db`. Fresh-project wizard OR in-place augmenter for an existing Nuxt 4 project, depending on where you run it.
- **`noy-db`** — ongoing CLI tool. Invoked via `pnpm exec noy-db <cmd>` or `npx noy-db <cmd>` from inside a project. Five subcommands: `add`, `add user`, `verify`, `rotate`, `backup`.

---

## `create noy-db` — the wizard

The wizard auto-detects whether your current directory is an existing Nuxt 4 project:

- If `nuxt.config.{ts,js,mjs}` **and** a `package.json` listing `nuxt` are both present, the wizard enters **augment mode** (patches the existing config in-place)
- Otherwise it enters **fresh mode** (creates a new subdirectory with a full Nuxt 4 starter)

### Fresh mode — new project

```bash
# In an empty directory
npm  create noy-db my-app
pnpm create noy-db my-app
yarn create noy-db my-app
bun  create noy-db my-app
```

The wizard asks at most 5 questions — project name, adapter, sample data, starter template, and sync adapter — then writes a complete starter into `./my-app/`. Nothing is installed automatically: pick your package manager and run it yourself (the wizard closes by printing `cd <project>`, `pnpm install`, `pnpm dev`).

Four starter templates ship in the package:

| Template | Stack | Why pick it |
|---|---|---|
| `nuxt-default` | Nuxt 4 + Pinia | SSR + file-based routing — **the default** |
| `vite-vue` | Vite + Vue 3 + Pinia | Client-side SPA, shorter install graph |
| `vanilla` | Vite + TypeScript | No framework, smallest footprint |
| `electron` | Electron + Vue 3 | Desktop app with the `to-file` adapter — USB workflow |

Skip the prompts with `--yes`:

```bash
npm create noy-db my-app --yes
npm create noy-db my-app --yes --adapter file --no-sample-data
```

### Augment mode — existing Nuxt 4 project

```bash
# From inside an existing Nuxt 4 project root
cd ~/my-existing-app
npm create noy-db
```

The wizard will:

1. **Detect** the existing `nuxt.config.ts` via the detection rule above
2. **Prompt** for the adapter (`browser` / `file` / `memory`)
3. **Patch** the config in-memory via [magicast](https://github.com/unjs/magicast):
   - Add `'@noy-db/in-nuxt'` to the `modules` array (creating the array if missing)
   - Add `noydb: { adapter, pinia: true, devtools: true }` (only if not already present)
4. **Show** a colored unified diff of the proposed changes
5. **Ask** for confirmation (`y/n`) — your config is only written if you confirm
6. **Print** the `pnpm add …` command for the packages the patched config now depends on

#### Safe behaviors

- **Idempotent**: re-running on an already-augmented project is a no-op. You'll see `Nothing to do — already configured`.
- **Preserves custom config**: a pre-existing `noydb:` key in your config is left untouched. The wizard only fills in what's missing.
- **Preserves unrelated keys, comments, and formatting**: magicast walks a real Babel AST, not a regex.
- **Unsupported shapes are rejected cleanly**: if your config uses an opaque export (`export default someVar`) or a non-array `modules` field, the wizard bails with a clear error message telling you to edit manually.

#### Dry run

Preview the diff without writing anything:

```bash
npm create noy-db --dry-run
```

Prints the unified diff and exits. Useful in CI, code review, and "what would this do to my config?" exploration.

#### Force fresh mode inside an existing project

If you're inside a Nuxt workspace but want to create a **new** sub-project rather than augment the root, pass `--force-fresh`:

```bash
cd ~/my-monorepo-with-nuxt
npm create noy-db my-sub-app --force-fresh
```

### All flags

| Flag | Effect |
|---|---|
| `<project-name>` (positional) | Target directory name (fresh mode only) |
| `-y`, `--yes` | Skip every prompt; use defaults |
| `--adapter <name>` | Pre-select adapter: `browser` (default) / `file` / `memory` |
| `--no-sample-data` | (fresh mode) Skip the seed invoice records |
| `--dry-run` | (augment mode) Show the diff without writing |
| `--force-fresh` | Force fresh-project mode even in an existing Nuxt dir |
| `--lang <code>` | UI language: `en` (default) / `th`. Auto-detected from `LC_ALL` / `LANG` when omitted |
| `-h`, `--help` | Show usage and exit |

#### Languages

The wizard's prompts and notes are available in **English** (default) and **Thai** (`th`). Pick a language explicitly with `--lang`:

```bash
npm create noy-db my-app --lang th
```

When `--lang` is omitted, the wizard reads the standard POSIX locale env vars (`LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE`) and auto-selects Thai when they point to a Thai locale, e.g.:

```bash
LANG=th_TH.UTF-8 npm create noy-db my-app
```

Validation errors and stack traces stay in English regardless of language so bug reports look the same in any locale.

---

## `noy-db` — the CLI tool

The `noy-db` bin ships inside the same `create-noy-db` package. Install it as a dev dependency and it's available via `pnpm exec` / `npx`:

```bash
pnpm add -D create-noy-db
pnpm exec noy-db <command>
```

### Commands at a glance

| Command | Purpose |
|---|---|
| `noy-db add <collection>` | Scaffold a new Pinia store + Vue page for a collection |
| `noy-db add user <id> <role>` | Grant a new user access to a compartment |
| `noy-db verify` | In-memory crypto round-trip integrity check |
| `noy-db rotate` | Rotate DEKs for one or more collections |
| `noy-db backup <target>` | Dump a compartment to an encrypted file |

All commands that touch real compartments use the **file adapter** and require these flags:

- `--dir <path>` — the data directory. Defaults to `./data`.
- `--compartment <name>` — the compartment (tenant) name. Required.
- `--user <id>` — your own user id in the compartment. Required.

You'll be prompted for your secret at runtime. Secrets are never echoed, never logged, never written to disk, and cleared from process memory when the command exits.

### `noy-db add <collection>`

Scaffolds two new files in your project:

- `app/stores/<name>.ts` — a `defineNoydbStore<Name>()` call with a placeholder interface
- `app/pages/<name>.vue` — a minimal CRUD page that lists, adds, and deletes records

```bash
pnpm exec noy-db add clients
```

Refuses to overwrite existing files — if either target already exists, the command exits non-zero without touching anything. There's no `--force` flag; delete the old files manually if you want to regenerate.

### `noy-db add user <userId> <role> [options]`

Grants a new user access to a compartment. Two secret prompts: yours (caller), then the new user's (with confirmation).

```bash
pnpm exec noy-db add user accountant-ann operator \
  --dir ./data \
  --compartment demo-co \
  --user owner-alice \
  --collections invoices:rw,clients:ro
```

Roles:

| Role | Permissions | Requires `--collections`? |
|---|---|:---:|
| `owner` | All collections, all operations | No |
| `admin` | All collections, all operations (except grant owner) | No |
| `viewer` | All collections, read-only | No |
| `operator` | Per-collection `rw` or `ro` explicitly | **Yes** |
| `client` | Per-collection `ro` explicitly | **Yes** |

For `operator` and `client`, the `--collections` flag is required. Format: `name1:rw,name2:ro,name3:rw`.

### `noy-db verify`

Runs an end-to-end crypto round-trip against an in-memory adapter. No real data is touched; the command creates a throwaway compartment, writes a record, reads it back, and verifies it decrypts correctly. Useful as a sanity check that `@noy-db/hub`, `@noy-db/to-memory`, and your local Node version all agree on Web Crypto.

```bash
pnpm exec noy-db verify
# ✔ noy-db integrity check passed (126ms)
```

Exits non-zero if anything diverges.

### `noy-db rotate [options]`

Rotate the DEKs for one or more collections in a compartment. Generates fresh keys, re-encrypts every record with the new keys, and re-wraps the new keys into every user's keyring. Nobody is revoked — everyone keeps their current permissions with fresh key material.

```bash
# Rotate every collection in the compartment
pnpm exec noy-db rotate --dir ./data --compartment demo-co --user owner-alice

# Rotate specific collections only
pnpm exec noy-db rotate --dir ./data --compartment demo-co --user owner-alice \
  --collections invoices,clients
```

Use cases:

- **Suspected key leak**: an operator lost a laptop, a developer accidentally pasted a secret into a Slack channel, a USB stick went missing. Rotating is cheap insurance.
- **Scheduled rotation**: some compliance regimes require periodic key rotation regardless of exposure. This command makes rotation scriptable from cron or a CI job.

Different from `noydb.revoke({ rotateKeys: true })` in that it doesn't kick anyone out — it's the "just rotate" path.

### `noy-db backup <target> [options]`

Dump a compartment to a local file. The dump is a **verifiable backup**: it includes the chain head and the full `_ledger` / `_ledger_deltas` snapshots, so `compartment.load()` on the receiving side will reject any tampering between dump and restore.

```bash
pnpm exec noy-db backup ./backups/demo-2026-04-07.json \
  --dir ./data --compartment demo-co --user owner-alice
```

Target paths:

- **Plain filesystem path** — `./backups/demo.json` or `/absolute/path.json`
- **`file://` URI** — `file:///absolute/path.json` or `file://./relative.json`

Parent directories are created on demand, so `./backups/2026/04/demo.json` works even if `./backups/2026/04/` doesn't exist yet.

Unsupported schemes (`s3://`, `https://`, etc.) are rejected **before** the secret prompt so a typo doesn't waste a secret entry.

### `noy-db help`

Prints the full usage message for all subcommands.

---

## Security invariants

Every command that touches real compartments follows these rules:

1. **Secret via `@clack/prompts` `password()`** — never echoes to the terminal, never logged.
2. **Secret never leaves the local closure** — no file writes, no error messages, no telemetry.
3. **Ctrl-C at the prompt aborts before any I/O happens** — cancelling doesn't leave the system in a half-mutated state.
4. **`finally { db.close() }`** — KEK is cleared from process memory on exit, success or failure.
5. **Unsupported backup schemes are rejected before the prompt** — a typo doesn't waste a secret entry.

---

## What's in the fresh-project template

```
my-app/
├── nuxt.config.ts          ← @noy-db/in-nuxt wired up with your chosen adapter
├── package.json            ← @noy-db/* deps at ^0.5.0
├── tsconfig.json
├── README.md
├── .gitignore
└── app/
    ├── app.vue
    ├── stores/
    │   └── invoices.ts     ← defineNoydbStore<Invoice>
    └── pages/
        ├── index.vue
        └── invoices.vue    ← CRUD page with reactive query DSL
```

Everything stored is encrypted with AES-256-GCM before it touches the adapter. The adapter only ever sees ciphertext.

---

## Deferred to a future release

These are explicit non-goals:

- **Thai i18n** of the wizard prompts ([#36](https://github.com/vLannaAi/noy-db/issues/36))
- **`noy-db seed`** — needs a design decision about how seed scripts authenticate
- **S3 backup targets** — would bundle `@aws-sdk` into this package and break the zero-runtime-deps story; lives in a companion package instead
- **`noy-db restore <file>`** — paired with the existing `compartment.load()` + integrity check; deferred so it can be designed alongside future identity/session work

Open an issue if you need one of these sooner.

---

## License

MIT
