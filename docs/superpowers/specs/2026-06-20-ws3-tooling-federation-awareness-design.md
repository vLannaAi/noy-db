# WS-3 tooling federation-awareness — design

**Status:** design (approved 2026-06-20) — ready for implementation plan
**Type:** cross-repo feature across the published-package seam. Workstream #3 (final) of the "orchestration → klum-db" boundary epic.
**Repos:** `vLannaAi/noy-db` (`@noy-db/in-devtools` — one type-only change) and `vLannaAi/klum-db` (`@klum-db/lobby` — all net-new tooling).
**Scope:** Core + group commands — make the **dev-tools, meter, and CLI** operate on a federation vault GROUP, not just a single vault.

## Goal

A federation operator can inspect and meter a whole `VaultGroup` — and drive it from a CLI — reusing the existing single-vault dev-tools, **without any `@noy-db` package importing `@klum-db`**. The `no-outbound-klum-import` guard stays green; group tooling lives in klum where it belongs.

## The boundary principle (why this is additive, not a relocation)

A federation's "atoms" are ordinary vaults: `VaultGroup.openShard(pk)` returns a real `@noy-db/hub` `Vault`. So the *vault-level* tools are already correct — only the **aggregating container** differs. We don't teach the tools "federation"; we make them accept any **container of vaults**, and a `VaultGroup` is one (via a klum-side adapter). Single-vault primitives stay in hub; group orchestration is klum's.

## Investigation findings (verified 2026-06-20)

- **`@noy-db/to-meter` is already federation-ready.** It wraps a `NoydbStore` (6-method interface, no vault binding). A group's shards are vaults opened from the same underlying store (`VaultGroup` holds `db: Noydb`, opens shards via `db.openVault(shardVaultId)`), so metering that store already captures all shard traffic. **No change.**
- **`@noy-db/in-devtools` is the one bottleneck, and the coupling is already structural.** `createInspector(noydb: InspectorNoydb, …)` where `InspectorNoydb = Noydb` (a *type alias*, all imports type-only). The inspector binds only these container members: `listAccessibleVaults()`, `onAfterWrite()`, `onWriteConflict()`, `writeQueue` (`pendingWrites` reads `.pending`/`.depth`). The driver (TUI bin) additionally calls `openVault(name)`. Per-vault methods (`snapshot(vault: Vault)`, `records(vault: Vault, …)`) take a **real `Vault`** — a group's member shard satisfies them natively, so no `VaultLike` is needed.
- **All container types are already public from `@noy-db/hub`:** `AccessibleVault` (`{ id: string; role: Role }`), `Vault`, `WriteHook` (`(e: WriteEvent) => void | Promise<void>`), `Unsubscribe` (`() => void`), `WriteConflict`, `WriteQueue` (interface with `pending`/`depth`). **PR-1 needs zero new hub exports.**
- **`VaultGroup` is a fan-out router**, not a singleton vault proxy. Public surface (all on its current API): `allRows(): Promise<VaultRegistryRow[]>`, `shard/openShard(pk): Promise<Vault>`, `resolveEligible({minVersion?})`, `collection(name): ShardedCollection`, and `readonly db: Noydb`. `VaultRegistryRow = { vaultId; partitionKey; templateName; schemaVersion; createdAt; group }`. It opens member vaults on demand (`db.openVault(shardVaultId)` + `template.configure(vault)`); it holds no live-vault pool.
- **klum has no group tooling yet** (no meter/inspect/cli/devtools). Its CLAUDE.md: *"Keep all cross-vault orchestration here… group-level tooling belongs in @klum-db/lobby."*
- **No `@noy-db` package imports `@klum-db`** today.

## Design

### Part A — noy-db: the `InspectableContainer` contract *(dev-tools)*

In `@noy-db/in-devtools`, define the input contract the inspector actually requires and narrow `createInspector` to it:

```ts
// packages/in-devtools/src/types.ts — reuses already-public hub types verbatim
import type { AccessibleVault, Vault, WriteHook, Unsubscribe, WriteConflict, WriteQueue } from '@noy-db/hub'

/** Any container of vaults the inspector can read — a Noydb or a federation adapter. */
export interface InspectableContainer {
  listAccessibleVaults(): Promise<readonly AccessibleVault[]>
  openVault(name: string): Promise<Vault>
  onAfterWrite(handler: WriteHook): Unsubscribe
  onWriteConflict(handler: (c: WriteConflict) => void): Unsubscribe
  readonly writeQueue: WriteQueue
}
```

- Replace `InspectorNoydb = Noydb` usage: `createInspector(container: InspectableContainer, opts?)`. Keep the `InspectorNoydb` alias as a deprecated re-export of `InspectableContainer` for one cycle (no breaking import churn), or drop it — TBD in plan; default keep.
- **Backward-compatible:** a real `Noydb` satisfies `InspectableContainer` verbatim (all five signatures match the public hub types). Existing callers, the TUI, and all current tests pass unchanged.
- Export `InspectableContainer` from the in-devtools barrel so klum can type its adapter against it.
- **Why in-devtools (not hub):** dependency inversion — the tool declares the abstraction it consumes; both `Noydb` and the klum `VaultGroup` adapter conform. Hub stays free of a devtools-specific type. (klum adds `@noy-db/in-devtools` as a peer dep for the type — see Part B.)

Publish a new `@noy-db` prerelease (manual lockstep bump).

### Part B — klum: `groupInspector` adapter *(dev-tools on a federation)*

In `@klum-db/lobby`, a `groupInspector(group: VaultGroup): InspectableContainer` built entirely on `VaultGroup`'s **current public API** + `group.db` — **no `VaultGroup` changes**:

| `InspectableContainer` member | Implementation | Notes |
|---|---|---|
| `listAccessibleVaults()` | `(await group.allRows()).map(r => ({ id: r.vaultId, role: 'owner' as Role }))` | group-scoped (registry rows are already filtered to this group); operator opens shards as owner |
| `openVault(name)` | `const v = await group.db.openVault(name); group.template.configure(v); return v` | apply the template like `openShard` does, so the inspected shard has its collections/indexes |
| `onAfterWrite(h)` | delegate to `group.db.onAfterWrite(h)`, filtered to this group's shard vaultIds | filter via the `allRows()` id set; ignores writes to vaults outside the group |
| `onWriteConflict(h)` | delegate to `group.db.onWriteConflict(h)`, same shard filter | |
| `writeQueue` | `group.db.writeQueue` | group shares the Noydb write queue |

Then `createInspector(groupInspector(group), { meter? })` and the existing TUI/CLI inspection flow run on a federation. Exported from klum's barrel as part of the group-tooling surface. **No `@klum` import lands in any `@noy-db` package** — the adapter lives in klum and merely *conforms to* a noy-owned interface.

### Part C — klum: group meter *(meter on a federation)*

- **Operational metering is already group-wide** — document it: `toMeter(store)` on the Noydb's store covers all shards (they share it). The CLI surfaces it via the existing `meter.snapshot()`.
- **New `meterGroup(group, opts?)`** — shape metrics fanned across **eligible** shards (`group.resolveEligible({minVersion?})`), reusing the per-vault pattern proven in `multi-bundle.ts` (`vault.collections()` then `collection(n).count()`):
  ```ts
  interface GroupMeterReport {
    readonly vaults: number
    readonly collections: number          // distinct collection names across the group
    readonly records: number              // summed across shards
    readonly perShard: ReadonlyArray<{ vaultId: string; partitionKey: string; schemaVersion: number; collections: number; records: number }>
    readonly skipped: ReadonlyArray<SkippedVault>   // drift / provisioning-failed shards, surfaced not hidden
  }
  ```
  Fan-out concurrency-bounded (reuse the federation runner's batch pattern); `skipped` is reported, never silently dropped.

### Part D — klum: CLI *(cli on a federation)*

Add a `klum` **bin to `@klum-db/lobby`** (`"bin": { "klum": "dist/bin/klum.js" }`, built by tsup) with two subcommands, mirroring `@noy-db/cli`'s thin arg-parser style (no new heavyweight CLI dep):

- `klum inspect-group <config.{js,mjs}> --group=<name> [--vault=<id>] [--meter]` — load options from config → `createLobby(await createNoydb(options))` → `openVaultGroup(name, …)` → `groupInspector(group)` → `createInspector(...)`; print vault list + per-vault snapshot (and a chosen shard's records when `--vault` given). `--meter` wraps the store via `toMeter` first.
- `klum meter-group <config> --group=<name>` — run `meterGroup(group)` and print the `GroupMeterReport` (totals + per-shard table + skipped).

Config shape mirrors the noy CLI's: a module default-exporting `NoydbOptions` (`{ store, user?, secret? }`) plus the vault-template registration the group needs. The CLI obtains the group purely through the published `@noy-db` + klum's own `Lobby`.

### Out of committed scope (decide at planning if wanted)
- **Group TUI mode** — wiring `groupInspector` into the Ink app (`@noy-db/in-devtools-tui`) so the TUI browses a federation. Feasible (the TUI already takes an `Inspector` + a `Vault`), but it's the only piece with real UI work; the CLI already delivers "operators can drive a fleet." Left out; foldable later.

## The publish-seam sequence (2-PR, additive)

Unlike WS-1 this is not a relocation — the capability is **new on both sides**, so there is no "missing from both" window. Order is by dependency only:

1. **noy-db PR-1** *(type-only)*: add `InspectableContainer` to `@noy-db/in-devtools`, narrow `createInspector`, export it. Tests/TUI unaffected (a `Noydb` still satisfies it). Merge → publish `@noy-db` next prerelease.
2. **klum PR-2** *(net-new)*: add `@noy-db/in-devtools` peer dep; add `groupInspector`, `meterGroup`, the `klum` CLI bin; export the group-tooling surface from the barrel; tests against the just-published `@noy-db`. Merge → publish `@klum-db/lobby` next prerelease.

## Testing & verification

- **noy-db PR-1:** existing in-devtools + TUI suites pass unchanged (proves backward-compat); add a type-level test that a `Noydb` is assignable to `InspectableContainer`; `pnpm check:architecture` (guard) + build/typecheck/lint green.
- **klum PR-2:** new suites — (a) `groupInspector` drives `createInspector` over a 2–3 shard group: `listAccessibleVaults` returns the shards, `snapshot`/`records` work on a materialized shard, write events fire on shard writes and are filtered to the group; (b) `meterGroup` totals match the sum of per-shard counts and surfaces a drifted/skipped shard; (c) CLI smoke test for `inspect-group`/`meter-group` against an in-memory store. All against the published `@noy-db`. Guard: confirm no `@noy-db` package imports `@klum-db` (unchanged — the adapter is klum-side).

## Design decisions (recorded)
1. **Contract home = `@noy-db/in-devtools`** (DIP), not hub. klum takes `@noy-db/in-devtools` as a peer dep for the type. Alternative (hub) rejected to keep hub free of a tool-specific interface.
2. **CLI = a `bin` in `@klum-db/lobby`**, not a separate `@klum-db/cli` package. klum is single-package today; splitting is premature (YAGNI).
3. **Per-vault role mapping** in the adapter = `'owner'` (the federation operator owns its shards via the Lobby's `db`). Revisit only if a non-owner inspection mode is needed.

## Risks / edge cases
- **Write-event scoping:** `group.db` may host vaults outside the group; the adapter MUST filter `onAfterWrite`/`onWriteConflict` to the group's shard vaultIds (from `allRows()`), refreshing the id set as shards are auto-created. Without the filter the inspector would surface cross-group writes.
- **`openVault` vs `openShard` parity:** the adapter applies `group.template.configure(vault)` so an inspected shard matches what `openShard` produces (collections/indexes present for `dumpSchema`/stats).
- **Eligible-only metering:** `meterGroup` walks `resolveEligible()` and reports `skipped` (schema-drift / provisioning-failed) rather than counting or hiding them — no silent truncation.
- **Backward-compat guarantee:** if any current caller relied on passing a `Noydb` *subtype with extra required params* the narrowing could bite — verified not the case (all internal callers pass a plain `Noydb`).

## Consequences
Closes the boundary epic. The pattern established — *extract the tool's true input contract as an interface in the tool's own package; let both the single-vault concrete type and a klum adapter conform; never let the tool import klum* — is the reusable recipe for making any future single-vault tool federation-capable.
