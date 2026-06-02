# Devtools Inspector — B2 TUI Design

> **Status:** Design (approved in brainstorming) — pre-plan
> **Date:** 2026-06-02
> **Track:** B (devtools inspector), slice B2 of 3 (B1 shipped: `@noy-db/in-devtools`)
> **Spec parent:** `docs/superpowers/specs/2026-06-02-devtools-inspector-b1-design.md`

## What this is

B2 is the **interactive terminal inspector** — a keyboard-navigable TUI that renders the B1 inspector core (`@noy-db/in-devtools` `createInspector`) for a live, unlocked noy-db. It is distinct from the existing CLI commands: `noydb inspect` prints a bundle *header* (no decryption), `noydb describe` audits a *bundle* schema, and `noydb monitor` shows *store metrics* (via `to-meter`). B2 inspects a live vault's structure, stats, records, and writes.

## Architecture

A new standalone package **`@noy-db/in-devtools-tui`** with its own `bin` (`noydb-inspect`). It uses **ink** (+ React) for the UI and consumes only `@noy-db/in-devtools` `createInspector` for data — no hub internals.

> Naming note: `in-*` is conventionally the framework-integration family; this is a TUI binary (closer to the unprefixed `cli` package). The name `@noy-db/in-devtools-tui` was chosen deliberately to keep it discoverable alongside `in-devtools`.

**Dependencies:**
- `dependencies`: `ink`, `react` (the app bundles its UI runtime).
- `peerDependencies`: `@noy-db/hub` (`workspace:*`, required by the peer-deps architecture invariant) and `@noy-db/in-devtools` (`workspace:*`).
- `devDependencies`: `@noy-db/hub`, `@noy-db/in-devtools`, `ink-testing-library`, `react`, plus the usual `tsup`/`vitest`.

**Boot flow (the bin):**
```
noydb-inspect <config> --vault=<name> [--passphrase=… | prompt]
  → loadOptionsFromFile(config)        # reuse the cli config-loader pattern
  → createNoydb(options)
  → passphrase (from --passphrase / env / masked interactive prompt — never echoed/logged)
  → noydb.openVault(vaultName, { passphrase })
  → createInspector(noydb)
  → render(<App inspector={inspector} vault={openVault} />)
```

The passphrase is used solely for `openVault` and is never persisted, echoed, or logged. The TUI is **read-only** (inherited B1 constraint) — no component writes.

## Decomposition (B2 is three slices)

Each is a working, testable unit on its own:

- **B2.1 — Shell + structure navigation** *(this plan builds first)*: package scaffold + `bin` + config-load + masked passphrase-open + the ink `App` rendering a **vaults → collections → schema/stats** tree with keyboard navigation (↑/↓ to move selection, ↵ to drill in, `q`/Ctrl-C to quit). Read-only structure browsing, end-to-end.
- **B2.2 — Records pane**: paged record browsing via `inspector.records` (next/prev page, page-size).
- **B2.3 — Live-write feed**: a pane streaming `inspector.subscribe` write events as they arrive.

B2.2 and B2.3 are separate spec → plan → implementation cycles after B2.1.

## B2.1 components

```
packages/in-devtools-tui/
  src/
    bin.tsx           # argv parse, config-load, passphrase resolution, openVault, render
    App.tsx           # root: holds selection state (vault/collection) + the open vault; routes keys
    PassphrasePrompt.tsx  # masked interactive input (used only when no --passphrase/env given)
    panes/
      VaultList.tsx   # accessible vaults (inspector.listVaults)
      CollectionList.tsx  # collections of the open vault (from inspector.snapshot)
      DetailPane.tsx  # schema fields + stats for the selected collection
  __tests__/
    app.test.tsx      # ink-testing-library: render + keypress assertions
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
```

Each component has one responsibility; `App` owns state and key routing, panes are presentational.

## Data flow

```
bin → openVault + createInspector → <App>
  App.useEffect: load listVaults() + snapshot(openVault) once
  App state: { vaults, snapshot, selectedVaultIdx, selectedCollectionIdx, focus }
  useInput(key): move selection / drill / quit
  <VaultList>, <CollectionList>, <DetailPane> render from App state (pure)
```

B2.1 inspects the single vault opened at boot (`--vault`). `listVaults()` populates the vault pane for context; drilling into other vaults (which need their own passphrase) is deferred (a later slice can prompt per vault).

## Error handling

- Missing/invalid config, missing `--vault`, wrong passphrase (`openVault` throws), or a store lacking the `listVaults` capability: the bin prints a clear stderr message and exits non-zero **before** entering the TUI (no half-rendered app).
- Inside the app, an inspector error (e.g. `snapshot` failure) renders as an error line in the `DetailPane` rather than crashing the render.

## Testing

`ink-testing-library` (`render()` → `lastFrame()` + `stdin.write(key)`):
- Renders the `App` against an in-memory `Noydb` + `createInspector` with an explicitly-injected open vault (no TTY prompt in tests).
- Asserts the initial frame shows the vault name and the seeded collection(s) with stats.
- Asserts ↓/↑ move the selection highlight and ↵ drills into a collection (DetailPane shows its fields).
- Asserts the read-only invariant: rendering + navigating does not mutate the store.
- The passphrase prompt is unit-tested with injected input; the bin's argv/config parsing is tested without launching ink.

## Constraints

- **Read-only** — no component writes; inherited from B1.
- **Passphrase hygiene** — used only for `openVault`; never echoed (masked prompt), never logged, never written to disk.
- **No hub internals** — all data via `createInspector`.

## Non-goals (B2.1)

- Records browsing (B2.2) and the live-write feed (B2.3).
- Multi-vault drill-in requiring additional passphrases (later slice).
- Mouse support, theming, resize handling beyond ink's defaults.
- Editing of any kind.

## Follow-on

- **B2.2** records pane, **B2.3** live feed.
- **B3** — browser panel (separate cycle; visual-companion mockups).
- Register `in-devtools-tui` in `features.yaml` + a showcase/recipe once the interactive surface stabilizes (TUIs are harder to showcase as a vitest; the `ink-testing-library` test is the executable proof).
