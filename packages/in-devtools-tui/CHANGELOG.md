# @noy-db/in-devtools-tui

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
