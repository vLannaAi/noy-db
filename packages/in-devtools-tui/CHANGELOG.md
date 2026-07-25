# @noy-db/in-devtools-tui

## 1.0.0-pre.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.0
  - @noy-db/in-devtools@1.0.0-pre.0
  - @noy-db/to-meter@1.0.0-pre.0

## 1.0.0

### Patch Changes

- CLI / scaffolder packaging polish (#704, #705).

  #704 — `create-noy-db` is published unscoped, but its README, package description, `--help`, and
  code comments documented the scoped `npm create @noy-db` / `@noy-db/create` spelling, which 404s.
  Every documented invocation now points at the working `npm create noy-db`, and the bin-naming
  rationale (create.ts / tsup.config.ts) is rewritten to describe the actual unscoped package rather
  than a never-shipped scoped one. No `@noy-db/create` alias is published — the canonical invocation
  is `npm create noy-db`.

  #705 — developer-tooling polish:

  - `@noy-db/in-devtools` and `@noy-db/in-devtools-tui` now ship a README (they published blank npm
    pages) and include it in `files`.
  - `noydb --version` derives from `package.json` at build time (was hardcoded `0.1.0`); the stale
    version string is dropped from the `@noy-db/cli` README.
  - Finished two truncated help/comment sentences: `--sync (multi-backend, )` → `(multi-backend)` in
    the scaffolder `--help`, and a dangling `monitor.ts` doc sentence.
  - `noydb config scaffold` now writes the loadable config to stdout and the `.env` template to
    stderr, so `noydb config scaffold > noydb.config.mjs` produces a clean, loadable config file.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0
  - @noy-db/in-devtools@1.0.0
  - @noy-db/to-meter@1.0.0

## 1.0.0-pre.13

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.13
  - @noy-db/in-devtools@1.0.0-pre.13
  - @noy-db/to-meter@1.0.0-pre.13

## 1.0.0-pre.12

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.12
  - @noy-db/in-devtools@1.0.0-pre.12
  - @noy-db/to-meter@1.0.0-pre.12

## 1.0.0-pre.11

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.11
  - @noy-db/in-devtools@1.0.0-pre.11
  - @noy-db/to-meter@1.0.0-pre.11

## 1.0.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.10
  - @noy-db/in-devtools@1.0.0-pre.10
  - @noy-db/to-meter@1.0.0-pre.10

## 1.0.0-pre.9

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.9
  - @noy-db/in-devtools@1.0.0-pre.9
  - @noy-db/to-meter@1.0.0-pre.9

## 1.0.0-pre.8

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.8
  - @noy-db/in-devtools@1.0.0-pre.8
  - @noy-db/to-meter@1.0.0-pre.8

## 1.0.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.7
  - @noy-db/in-devtools@1.0.0-pre.7
  - @noy-db/to-meter@1.0.0-pre.7

## 1.0.0-pre.6

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.6
  - @noy-db/in-devtools@1.0.0-pre.6
  - @noy-db/to-meter@1.0.0-pre.6

## 0.3.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.5
  - @noy-db/in-devtools@0.3.0-pre.5
  - @noy-db/to-meter@0.3.0-pre.5

## 0.3.0-pre.4

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.4
  - @noy-db/in-devtools@0.3.0-pre.4
  - @noy-db/to-meter@0.3.0-pre.4

## 0.3.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.3
  - @noy-db/in-devtools@0.3.0-pre.3
  - @noy-db/to-meter@0.3.0-pre.3

## 0.3.0-pre.2

### Minor Changes

- 0.3 version line continues — lockstep with `@noy-db/hub` 0.3.0-pre.2 (describe() group/order metadata, \_history in the .noydb pod; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.2
  - @noy-db/in-devtools@0.3.0-pre.2
  - @noy-db/to-meter@0.3.0-pre.2

## 0.3.0-pre.1

### Minor Changes

- 0.3 version line — lockstep with `@noy-db/hub` 0.3.0-pre.1 (kernel/enclave reorg, family doors, `withX()` service gating; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/in-devtools@0.3.0-pre.1
  - @noy-db/to-meter@0.3.0-pre.1
  - @noy-db/hub@0.3.0-pre.1

## 0.2.0-pre.31

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.31
  - @noy-db/in-devtools@0.2.0-pre.31
  - @noy-db/to-meter@0.2.0-pre.31

## 0.2.0-pre.5

Initial release. A **terminal inspector** for noy-db built on ink/React ([#265](https://github.com/vLannaAi/noy-db/issues/265), Track B — B2.1).

- **`noydb-inspect`** bin: loads config, resolves a passphrase, opens the vault, and renders keyboard-navigable **vaults → collections → schema/stats** panes over `@noy-db/in-devtools`.
- Read-only, headless-friendly (no browser) — for server / CI / SSH inspection contexts.
- Records pane (paged `inspector.records`, Tab to switch, n/p to page).
- Write Monitor (`w`): live write feed with multi-user overlap/conflict highlighting + auto-light-up store-latency (`--meter`).
- Masked interactive passphrase prompt.
