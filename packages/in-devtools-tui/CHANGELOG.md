# @noy-db/in-devtools-tui

## 0.2.0-pre.5

Initial release. A **terminal inspector** for noy-db built on ink/React ([#265](https://github.com/vLannaAi/noy-db/issues/265), Track B — B2.1).

- **`noydb-inspect`** bin: loads config, resolves a passphrase, opens the vault, and renders keyboard-navigable **vaults → collections → schema/stats** panes over `@noy-db/in-devtools`.
- Read-only, headless-friendly (no browser) — for server / CI / SSH inspection contexts.
