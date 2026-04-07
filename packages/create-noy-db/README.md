# @noy-db/create

Wizard + CLI tool for [noy-db](https://github.com/vLannaAi/noy-db) — scaffold a fresh Nuxt 4 + Pinia encrypted store in about 30 seconds, or add collections to an existing project.

## Quick start

### New project

```bash
npm  create @noy-db my-app
pnpm create @noy-db my-app
yarn create @noy-db my-app
bun  create @noy-db my-app
```

> **Why the scoped invocation?** npm's `npm init @scope` convention resolves to the `@scope/create` package and runs its `create` bin. Keeping the package inside the `@noy-db` scope keeps us publishing from the same CI token we use for every other `@noy-db/*` package — no token juggling, no surprise 403s.

The wizard asks at most 3 questions (project name, adapter, sample data), generates a Nuxt 4 starter, and prints the next steps. Nothing is installed automatically — pick your package manager and run it yourself.

**Skip the prompts** with `--yes` (everything defaults):

```bash
npm create @noy-db my-app --yes
npm create @noy-db my-app --yes --adapter file --no-sample-data
```

### Existing project

From the root of an existing Nuxt 4 project that has `@noy-db/nuxt` installed:

```bash
# Add a new collection + Pinia store + page
pnpm exec noy-db add clients
# or: npx noy-db add clients

# End-to-end crypto integrity check (in-memory, no secrets prompted)
pnpm exec noy-db verify
```

The `noy-db` bin ships inside the same `@noy-db/create` package — install it as a dev dependency and it's available via `pnpm exec` / `npx`:

```bash
pnpm add -D @noy-db/create
pnpm exec noy-db add invoices
```

## Commands

### `create` bin — the wizard

Invoked via `npm create @noy-db` (not `create create` — npm resolves the scope to the package automatically).

| Flag | Effect |
|---|---|
| `<project-name>` (positional) | Target directory name |
| `--yes` / `-y` | Skip every prompt; use defaults for missing values |
| `--adapter <name>` | Pre-select adapter: `browser` (default) / `file` / `memory` |
| `--no-sample-data` | Don't include seed invoice records |
| `--help` / `-h` | Show usage |

### `noy-db` bin — the tool

| Command | Effect |
|---|---|
| `noy-db add <collection>` | Scaffold `app/stores/<name>.ts` and `app/pages/<name>.vue`. Refuses to overwrite existing files. |
| `noy-db verify` | Run an end-to-end crypto round-trip against an in-memory adapter. Exits non-zero if anything diverges. |
| `noy-db help` | Show usage |

## What's in the generated project

```
my-app/
├── nuxt.config.ts          ← @noy-db/nuxt wired up with your chosen adapter
├── package.json            ← @noy-db/* deps at ^0.3.0
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

Everything in the store is encrypted with AES-256-GCM before it touches the adapter. The adapter only ever sees ciphertext.

## Deferred to a follow-up

These are explicit non-goals for the v0.3.1 release of `@noy-db/create`:

- **Thai i18n** of prompts (add in v0.4+)
- **Magicast AST patching** of existing `nuxt.config.ts` (add in v0.4+ — for now the wizard only generates fresh projects; use `noy-db add` to add collections to existing ones)
- **`rotate`, `seed`, `backup`, `add user` subcommands** (add in v0.4+ — they need a CLI auth story we don't have yet)
- **Templates other than Nuxt 4** — no Vite, no vanilla Vue, no other frameworks

Open an issue if you need one of these sooner.

## License

MIT
