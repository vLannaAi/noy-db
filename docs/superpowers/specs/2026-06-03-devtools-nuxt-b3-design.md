# Devtools — B3 Nuxt DevTools Tab Design

> **Status:** Design (approved in brainstorming)
> **Date:** 2026-06-03
> **Track:** B (devtools inspector). Browser-side inspector panel.
> **Spec parent:** `docs/superpowers/specs/2026-06-02-devtools-inspector-b2-tui-design.md`
> **Builds on:** B1 (`@noy-db/in-devtools`) — facade already shipped. No new facade methods needed.

## What this is

A Nuxt DevTools tab that surfaces the same three inspector surfaces the TUI provides — structure (vault/collection/schema/stats), records browsing, and the live write monitor — directly inside the Nuxt DevTools overlay in dev mode. Zero extra user setup for Pinia users: the panel auto-discovers the active db via `getActiveNoydb()`.

## Goals

- Browse vaults, collections, schema, and stats without leaving the browser.
- Page through decrypted records of the selected collection.
- Watch writes commit in real time across the vault, with multi-user overlap/conflict highlighting and optional store-latency readout.
- Ship entirely inside the existing `@noy-db/in-nuxt` package — no new package.
- Zero extra wiring for users who already call `setActiveNoydb(db)`.

## Non-goals

- Cross-vault inspection requiring multiple passphrases (deferred, same as TUI).
- React / Svelte / vanilla framework support (this is Nuxt-specific; a future `@noy-db/in-devtools-ui` standalone overlay could serve other frameworks).
- Editing, mutations, or any write path.
- `@nuxt/devtools-kit` as a dependency — the tab is registered via the `devtools:customTabs` hook in Nuxt core.
- Per-write latency keyed to a specific `docId` (aggregate only, same as TUI).
- Mouse-resize, theming controls.

## Architecture

### Registration (dev mode only)

The module's `setup()` function, guarded by `nuxt.options.dev === true && options.devtools !== false`, does two things:

1. **Virtual page** — `addTemplate` generates a virtual `noydb-devtools.vue` entry into `.nuxt/`, and `extendPages` mounts it at `/_noydb-devtools`. Because this is a real Nuxt route the panel runs inside the user's full Vue app: same provide/inject tree, same composables, direct reactive access to `getActiveNoydb()`. No iframe communication protocol needed.

2. **DevTools tab** — `nuxt.hook('devtools:customTabs', (tabs) => { tabs.push({ name: 'noy-db', title: 'noy-db', icon: 'i-carbon-data-base', view: { type: 'iframe', src: '/_noydb-devtools' } }) })`. No `@nuxt/devtools-kit` import — the hook is part of Nuxt core. The `i-carbon-data-base` icon is available via UnoCSS's icon preset (already used by Nuxt DevTools itself).

Both registrations are skipped in production builds and when `devtools: false` is set in module options.

### Inspector lifecycle

`DevtoolsPanel.vue` mounts → calls `getActiveNoydb()` (from `@noy-db/in-pinia`, already auto-imported by the module). Result is `provide`d as `InspectorKey` to all child panes so they `inject` it directly. The inspector is created once: `createInspector(db)`.

Write-monitor subscriptions (`subscribe`, `subscribeConflicts`) start when the Monitor tab is first activated and persist for the panel's lifetime (panel unmount cleans them up). The latency poll (`meterSnapshot()` every 1 s) runs only while the Monitor tab is mounted.

### Layout — A (sidebar + tabbed detail)

```
┌ noy-db ── Structure ── Monitor ─────────────────── ● myvault ┐
│ Vault          │ ── Schema ── Records ─────────────────────── │
│ ▸ myvault      │                                              │
│   invoices 142 │  Fields                                      │
│   customers 38 │  id        string   pk                       │
│   payments  91 │  amount    number                            │
│                │  status    string   idx                       │
│                │                                              │
│                │  Stats: 142 docs · 48 KB · 1 index           │
└────────────────┴──────────────────────────────────────────────┘
```

Two top-level tabs:
- **Structure** — sidebar (vault name + collection list with doc counts) + detail area (Schema / Records sub-tabs).
- **Monitor** — full-width write monitor (latency bar + feed, no sidebar).

The vault name in the top-right status area doubles as a live indicator: green dot + name when a vault is open, grey "no vault" otherwise.

## Components

All new files live under `packages/in-nuxt/src/runtime/devtools/`. Nuxt compiles them as part of the user's app build (tsup only compiles the module bootstrap).

| File | Responsibility |
|---|---|
| `DevtoolsPanel.vue` | Root panel. `getActiveNoydb()` → `createInspector(db)` → provides `InspectorKey`. Top-level tab routing (Structure / Monitor). Empty states. |
| `panes/VaultSidebar.vue` | Vault name header + collection list with doc counts. Emits `select` when a collection is clicked. |
| `panes/SchemaPane.vue` | Field list (name / type / flags) + collection stats. Pure display — receives `InspectorCollection` as a prop. |
| `panes/RecordsPane.vue` | Paged records table. `inspector.records(vault, coll, { limit: 20, offset })` on mount and on prev/next. Column headers inferred from `collection.fields`. Non-scalar values shown as `{…}` / `[n]`. |
| `panes/WriteMonitor.vue` | Latency bar (polled 1 s from `inspector.meterSnapshot()`) + bounded feed (cap 200) from `inspector.subscribe()` + `inspector.subscribeConflicts()`. Conflict rows highlighted. |

`module.ts` gains the dev-only registration block (template + page + devtools hook).

## Data flow

```
DevtoolsPanel mounts
  → getActiveNoydb()
      null  → empty state ("call setActiveNoydb(db) in your plugin")
      Noydb → createInspector(db) → provide(InspectorKey, inspector)
            → inspector.listVaults() → sidebar vault list (VaultInfo[])
            → auto-select first vault
            → db.openVault(info.id) → Vault handle (returns cached; no re-derivation)
            → inspector.snapshot(vault) → collection list + counts

User selects collection
  → SchemaPane: renders fields + stats from snapshot (no fetch)
  → Records tab activated → RecordsPane: inspector.records(vault, coll, { limit:20, offset })
  → prev/next → offset ± 20 → re-fetch

Monitor tab activated (first time)
  → inspector.subscribe(handler) → feed rows (newest first, cap 200)
  → inspector.subscribeConflicts(handler) → flag matching rows + future rows
  → setInterval(1000, () => setMeter(inspector.meterSnapshot())) while mounted
  → subscriptions persist after leaving Monitor tab; cleared on panel unmount
```

## Error handling

| Condition | Behaviour |
|---|---|
| `getActiveNoydb()` returns null | Full-panel empty state with setup tip; no crash |
| `listVaults()` returns `[]` | "No open vaults — unlock a vault in your app first" |
| `snapshot()` rejects | Inline error in sidebar; retry on vault re-select |
| `records()` rejects | Error message in RecordsPane; prev/next remain usable |
| Subscribe handler throws | Caught per-event; shown as dim `feed error` row; subscription stays alive |
| `meterSnapshot()` null or throws | Latency bar hidden; feed unaffected |

## Testing

**Module registration** (`__tests__/module.test.ts`, extends existing suite):
- Devtools tab registered when `dev: true` and `devtools` not false.
- Tab NOT registered when `dev: false` or `devtools: false`.
- Virtual page route added at `/_noydb-devtools` in dev mode.

**Panel + panes** (`__tests__/devtools-panel.test.ts`, `@vue/test-utils` + fake inspector):
- Happy path: vault open → sidebar shows collections → Schema tab shows fields → Records tab loads first page → prev/next pages → Monitor tab shows feed rows → conflict highlights.
- Empty state: `getActiveNoydb()` returns null → empty state message rendered.
- No vault: `listVaults()` returns `[]` → "no open vaults" message.
- Error state: `records()` rejects → error message in RecordsPane.
- Latency bar: `meterSnapshot()` returns snapshot → header shows p50/p99; returns null → header absent.

Fake inspector shape mirrors the TUI's `fakeInspector()` from `monitor.test.tsx`; extract to a shared `__tests__/helpers/fake-inspector.ts` in `@noy-db/in-devtools` if both packages need it.

## Packaging / registry

- No new package. Extends `@noy-db/in-nuxt`.
- `@noy-db/in-devtools` added to `dependencies` of `@noy-db/in-nuxt` (the panel imports `createInspector` directly; this is an internal implementation detail, not a user-visible peer requirement).
- `features.yaml`: add `in-devtools-nuxt` feature entry under the devtools group, or extend the existing `in-devtools` entry's description.
- Showcase: headless showcase (no real Nuxt server) verifying the fake-inspector + pane rendering via `@vue/test-utils`. TUI showcase 91 already covers the facade; this showcase proves the Vue panes work end-to-end.
- `packages/in-nuxt/CHANGELOG.md`: new entry for devtools tab.

## Module options delta

Add to `ModuleOptions` (already has the `devtools?: boolean` passthrough):

```ts
devtools?: boolean  // already exists — no change needed; false disables the tab
```

No new config keys. The panel is always-on in dev mode unless `devtools: false`.

## Follow-on

- **Standalone overlay** (`@noy-db/in-devtools-ui`) — a framework-agnostic floating panel (Shadow DOM, no Nuxt dep) for Vue/React/Svelte/vanilla apps. Possible B4.
- **Vault selector dropdown** — when multiple vaults are open, a dropdown in the header switches the active vault without reloading. Deferred; most apps have one open vault.
- **Per-write latency** — requires a `to-meter` change to tag samples by `docId`. Out of scope.
