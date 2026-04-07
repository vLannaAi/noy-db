# create-noy-db

## 0.3.1

### Minor Changes

- **Initial release of `create-noy-db`** — wizard + CLI tool for noy-db (closes #7, closes #9).

  Ships **two bins** from a single package:

  **`create-noy-db`** — wizard for new projects, invoked by `npm create noy-db@latest`:

  ```bash
  npm  create noy-db@latest my-app
  pnpm create noy-db        my-app
  yarn create noy-db        my-app
  bun  create noy-db        my-app
  ```

  Interactive mode asks 3 questions (project name, adapter, sample-data yes/no) and generates a fully wired Nuxt 4 + Pinia + encrypted-store starter. Non-interactive `--yes` mode skips every prompt and uses defaults.

  **`noy-db`** — ongoing CLI tool for existing projects, invoked via `pnpm exec noy-db <command>` or `npx noy-db <command>`:

  - `noy-db add <collection>` — scaffolds `app/stores/<name>.ts` and `app/pages/<name>.vue`. Refuses to overwrite existing files (atomic — either both land or neither does).
  - `noy-db verify` — end-to-end crypto round-trip check against an in-memory adapter. Exits non-zero if any step diverges. Validates that `@noy-db/core`, `@noy-db/memory`, and the local Node version all agree on Web Crypto.

  **Nuxt 4 only.** The template generates a Nuxt 4 project using `@noy-db/nuxt@^0.3.0` and `@noy-db/pinia@^0.3.0`. No Vite, no vanilla Vue, no other frameworks.

  **Scope deferred to a follow-up** (tracked in new issues):
  - Thai i18n of prompts
  - Magicast AST patching of existing `nuxt.config.ts`
  - Additional `noy-db` subcommands: `rotate`, `seed`, `backup`, `add user`
  - E2E CI matrix across macOS/Linux/Windows × Node 20/22

  The v0.3.1 release covers the 80% of the adoption story that's actually load-bearing: generating a fresh project that builds, and adding collections to an existing project from the command line.
