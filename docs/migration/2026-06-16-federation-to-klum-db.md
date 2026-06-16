# Consumer migration: federation → `@klum-db/lobby`

**Date:** 2026-06-16
**Applies to:** anyone consuming `@noy-db/hub` federation (VaultGroup / sharding / state-vault / insight / fleet-migration / cross-shard-join).
**Status of the change:** merged to `main` (#450 + #452), **not yet published** to npm.

> Keyed by **app name** below, not pilot-N — the pilot numbering varies across notes. The two consumers in scope:
> - **niwat** (multi-party tax-agent app; the federation-driving recipe) → **migrates to `@klum-db/lobby`.**
> - **i3speedex** (Speedex refoundation; transitionGuard / formatted-sequences / refArray / FK-derivations) → **almost certainly does NOT need klum-db** (see Part B).

---

## 1. What changed

Federation was extracted out of `@noy-db/hub` into a new package **`@klum-db/lobby`** (the outward "orchestrate many vaults" framework). Concretely:

- **`db.openVaultGroup()` / `db.openStateManagementVault()` / `db.withVaultTemplate()` now throw `FederationMovedError`.** The entry point is the **`Lobby`** class: `createLobby(db).openVaultGroup(...)`.
- **Federation *types*** (`VaultGroup`, `VaultTemplate`, `VaultGroupOptions`, `VaultRegistryRow`, `CrossVaultDerivationSpec`, `MigrationStatusRow`, …) are **no longer exported from `@noy-db/hub`** — import them from `@klum-db/lobby`.
- **Federation *error classes*** (`CrossShardJoinError`, `UnknownShardError`, `ShardProvisioningError`, `VaultTemplateNotFoundError`, `ReservedVaultNameError`, `DataResidencyError`) and **`STATE_VAULT_NAME`** remain public on `@noy-db/hub` **and** are re-exported from `@klum-db/lobby`. Catch them from whichever you depend on.
- `@klum-db/lobby` binds to a new **`@noy-db/hub/kernel`** subpath (only present in the new, unpublished hub).

The methods on a returned group/state object are **unchanged** — `firm.collection()`, `firm.query()`, `firm.withCrossVaultDerivation()`, `firm.refreshInsights()`, `firm.migrateFleet()`, `state.registry`, etc. Only *how you obtain* the group/state moves from `db` to `lobby`.

---

## 2. Do you even need klum-db? (the grep test)

Run this in your consumer repo:

```bash
grep -rnE "openVaultGroup|openStateManagementVault|withVaultTemplate|VaultGroup|VaultRegistryRow|VaultTemplate|StateManagementVault|withCrossVaultDerivation|refreshInsights|migrateFleet|crossShardJoin|broadcastJoin|CrossVaultDerivationSpec" src/
```

- **Zero hits → you do NOT need `@klum-db/lobby`.** The federation removal is a no-op for you; the new `@noy-db/hub` is backward-compatible. Just bump hub when it publishes. *(Expected for i3speedex.)*
- **Any hits → migrate** those call-sites to the Lobby API (Part A). *(niwat.)*

---

## Part A — niwat (federation user)

### A1. Consume the unpublished hub + lobby locally

niwat is a separate repo, so `workspace:*` doesn't reach it, and **lobby needs the *new* hub** (with `/kernel`) which isn't on npm. Provide **both** from your local noy-db build. Pick one:

**yalc (day-to-day loop):**
```bash
# in noy-db
pnpm build
(cd packages/hub  && npx yalc publish)
(cd packages/lobby && npx yalc publish)
# in niwat
npx yalc add @noy-db/hub @klum-db/lobby
pnpm install
# after each noy-db change:
#   (in noy-db) pnpm build && (cd packages/hub && npx yalc push) && (cd packages/lobby && npx yalc push)
```

**Tarballs (milestone / CI validation — closest to the real artifact):**
```bash
# in noy-db
pnpm build
(cd packages/hub  && pnpm pack)   # noy-db-hub-0.2.0-pre.23.tgz
(cd packages/lobby && pnpm pack)  # klum-db-lobby-0.2.0-pre.23.tgz
```
```jsonc
// niwat package.json
"@noy-db/hub":    "file:../noy-db/packages/hub/noy-db-hub-0.2.0-pre.23.tgz",
"@klum-db/lobby": "file:../noy-db/packages/lobby/klum-db-lobby-0.2.0-pre.23.tgz"
```

> ⚠️ Do **not** mix the npm-published `@noy-db/hub` (old, still has federation, no `/kernel`) with a local lobby — lobby's `@noy-db/hub/kernel` imports won't resolve. Use the local hub.
> ⚠️ Do **not** `link:`/`file:` the `packages/lobby` *directory* — its `@noy-db/hub: workspace:*` peer is unresolvable outside the monorepo. yalc/pack rewrite it, which is why they work.

### A2. Add ONE adapter module (contains all klum-db churn)

Create `src/lib/klum.ts` in niwat. Every klum-db touchpoint goes through here, so the FR work that follows lands in one file, not scattered across the app.

```ts
// src/lib/klum.ts — niwat's single point of contact with @klum-db/lobby
import type { Noydb } from '@noy-db/hub'
import { createLobby, type Lobby } from '@klum-db/lobby'

// One Lobby per Noydb runtime, memoized. CRITICAL: withVaultTemplate(...) and the
// subsequent openVaultGroup(...) MUST run on the SAME Lobby instance — the Lobby
// holds the vault-template registry (it used to live on the Noydb). The WeakMap
// guarantees same-db → same-lobby, preserving that ordering invariant.
const lobbies = new WeakMap<Noydb, Lobby>()

export function lobbyFor(db: Noydb): Lobby {
  let l = lobbies.get(db)
  if (!l) {
    l = createLobby(db)
    lobbies.set(db, l)
  }
  return l
}

// Re-export the federation surface niwat uses from its new home, so app code
// imports from './lib/klum' (stable) rather than '@klum-db/lobby' directly.
// Add the names you actually use.
export type {
  VaultGroup,
  VaultTemplate,
  VaultGroupOptions,
  VaultRegistryRow,
  CrossVaultDerivationSpec,
  RefreshInsightsResult,
  MigrationStatusRow,
  FleetMigrationResult,
} from '@klum-db/lobby'

export {
  CrossShardJoinError,
  UnknownShardError,
  ShardProvisioningError,
  VaultTemplateNotFoundError,
  ReservedVaultNameError,
  DataResidencyError,
} from '@klum-db/lobby'
```

### A3. Rewrite the call-sites

| Before (`@noy-db/hub`) | After |
|---|---|
| `db.withVaultTemplate(name, tmpl)` | `lobbyFor(db).withVaultTemplate(name, tmpl)` |
| `await db.openVaultGroup(name, opts)` | `await lobbyFor(db).openVaultGroup(name, opts)` |
| `await db.openStateManagementVault()` | `await lobbyFor(db).openStateManagementVault()` |
| `import type { VaultRegistryRow, … } from '@noy-db/hub'` | `import type { VaultRegistryRow, … } from './lib/klum'` |
| `import { CrossShardJoinError } from '@noy-db/hub'`* | `import { CrossShardJoinError } from './lib/klum'` |

\* federation error classes still resolve from `@noy-db/hub` too, but routing them through `./lib/klum` keeps one source of truth. **Unchanged:** every method on the returned `firm`/`state` object (`firm.query`, `firm.withCrossVaultDerivation`, `firm.refreshInsights`, `firm.migrateFleet`, `state.registry`, …) and all plain vault access (`db.openVault(...)`, `db.collection(...)`).

### A4. Verify

```bash
# after wiring local hub+lobby
pnpm typecheck && pnpm test
# nothing should still call the removed methods on db:
grep -rnE "\bdb[A-Za-z0-9]*\.(openVaultGroup|openStateManagementVault|withVaultTemplate)\b" src/   # expect: no hits
```
A leftover `db.openVaultGroup(...)` won't fail typecheck (the shim still has the name) — it throws `FederationMovedError` at runtime. The grep is the real check.

### A5. Going forward — adopt FRs incrementally

As the pilot-1 epic (#440) FRs land in `@klum-db/lobby` (Bundle/Manifest, Relocate, Merge, Authority, Provenance, Deed/Custodian/Liberate, Surface, Migrate), pull each via the same local setup and surface it through `./lib/klum`. Validate each against real niwat onboarding/withdrawal flows as it ships — don't wait for the whole epic.

---

## Part B — i3speedex (Speedex): likely **no** klum-db

i3speedex was refounded on hub-core features — `transitionGuard`, formatted sequences, `refArray`, FK derivations — **none of which are federation**. So:

1. **Run the grep test (§2).** Expected: **zero** federation hits.
2. **If zero hits → do nothing klum-db.** The federation removal does not affect you. When the new `@noy-db/hub` publishes, bump it like any normal release; your code is unchanged.
3. **If (unexpectedly) some hits →** migrate only those specific call-sites per Part A (add `src/lib/klum.ts`, route just those through it). Everything else stays on `@noy-db/hub`.
4. **Do NOT add `@klum-db/lobby` "to be safe."** It pulls in the outward orchestration layer i3speedex doesn't use. The whole point of the inward/outward split is that single-vault apps stay on the lean `@noy-db/hub`.

**Net:** i3speedex's "migration" is expected to be a no-op + a grep confirmation. If that holds, record it (in its repo notes) and move on.

---

## 3. Don'ts (both apps)

- Don't publish `@klum-db/*` to npm during co-development — consume locally (yalc/tarball) until the API stabilizes across a few FRs.
- Don't scatter `@klum-db/lobby` imports through the app — keep them behind the one adapter module.
- Don't pair local lobby with npm hub (version says `pre.23` but it's the old federation-bearing hub without `/kernel`).
