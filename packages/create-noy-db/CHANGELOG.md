# @noy-db/create

## 0.4.1

### Patch Changes

- **Peer dep fix**: changed `peerDependencies` spec from `workspace:*` to `workspace:^` so published packages accept any semver-compatible `@noy-db/*` version rather than pinning to the exact version the workspace was built against. Without this fix, installing `@noy-db/core@0.4.0` alongside `@noy-db/memory@0.3.0` produced an `ERESOLVE` error because memory's peer dep was published as the literal `"0.3.0"` string.

- **Version line unified**: every `@noy-db/*` package is now on the **0.4.1** line. Previously the line was mixed (core/pinia on 0.4.0, adapters on 0.3.0, vue on 0.2.0, create on 0.3.2). No functional code changes — this is a manifest-only release to make v0.4 actually installable.

## 0.3.2

### Patch Changes

- **Fix `noy-db verify` broken on npm installs.** In v0.3.1, `@noy-db/core` and `@noy-db/memory` were declared as `devDependencies` instead of `dependencies`. The wizard (`create` bin) worked fine because it only writes files, but the `noy-db verify` command imports both packages at runtime and threw `ERR_MODULE_NOT_FOUND` as soon as a user installed `@noy-db/create` from npm and ran `pnpm exec noy-db verify`.

  The fix moves both to `dependencies` so they land in `node_modules/@noy-db/create/node_modules/` on install. No API changes, no code changes beyond the manifest.

  **v0.3.1 has been deprecated on npm.** Please upgrade:

  ```bash
  pnpm add -D @noy-db/create@latest
  ```

## 0.3.1

### Minor Changes

- **Initial release of `@noy-db/create`** — wizard + CLI tool for noy-db (closes #7, closes #9).

  Ships **two bins** from a single package:

  **`create`** — wizard for new projects, invoked via npm's scoped-initializer idiom:

  ```bash
  npm  create @noy-db my-app
  pnpm create @noy-db my-app
  yarn create @noy-db my-app
  bun  create @noy-db my-app
  ```

  Interactive mode asks 3 questions (project name, adapter, sample-data yes/no) and generates a fully wired Nuxt 4 + Pinia + encrypted-store starter. Non-interactive `--yes` mode skips every prompt and uses defaults.

  **`noy-db`** — ongoing CLI tool for existing projects, invoked via `pnpm exec noy-db <command>` or `npx noy-db <command>`:

  - `noy-db add <collection>` — scaffolds `app/stores/<name>.ts` and `app/pages/<name>.vue`. Refuses to overwrite existing files (atomic — either both land or neither does).
  - `noy-db verify` — end-to-end crypto round-trip check against an in-memory adapter. Exits non-zero if any step diverges. Validates that `@noy-db/core`, `@noy-db/memory`, and the local Node version all agree on Web Crypto.

  **Nuxt 4 only.** The template generates a Nuxt 4 project using `@noy-db/nuxt@^0.3.0` and `@noy-db/pinia@^0.3.0`. No Vite, no vanilla Vue, no other frameworks.

  **Why scoped?** Publishing inside the `@noy-db` scope lets us reuse the existing npm token (which has create-package rights inside the scope only). An unscoped `create-noy-db` package would have required a new wider-scoped token. See the PR discussion on #33 + the fix PR for details.

  **Scope deferred to a follow-up** (tracked in new issues):
  - Thai i18n of prompts
  - Magicast AST patching of existing `nuxt.config.ts`
  - Additional `noy-db` subcommands: `rotate`, `seed`, `backup`, `add user`
  - E2E CI matrix across macOS/Linux/Windows × Node 20/22

  The v0.3.1 release covers the 80% of the adoption story that's actually load-bearing: generating a fresh project that builds, and adding collections to an existing project from the command line.
