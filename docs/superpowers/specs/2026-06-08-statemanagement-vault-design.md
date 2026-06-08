# StateManagement Vault — federation control plane (Layer 3, slice 1)

**Epic:** #271 (multi-vault partition federation) · **Layer:** 3 (StateManagement Vault) · **Status:** design spec — **not implemented**.

This slice formalizes the federation **control plane** as a first-class, owned abstraction. Today the `vault-registry` is hand-rolled by callers (`stateVault.collection<VaultRegistryRow>('n')` in `federation-*.test.ts`); the registry *concept* exists (`VaultRegistryRow`, `VaultGroupOptions.registry`) but nothing owns it. This slice introduces a `StateManagementVault` that owns the registry, a per-version `schema-manifest`, and a WORM `deployment-events` log, and auto-wires it into `openVaultGroup`.

## Scope

**In this slice:**
- `StateManagementVault` class owning three collections: `registry`, `schemaManifest`, `deploymentEvents`.
- Auto-wiring into `openVaultGroup` (registry becomes optional; backward-compatible).
- Per-version schema manifest (serializable blueprint + fingerprint) with drift detection.
- WORM deployment-events log (rides existing `immutableGuard`).

**Deferred (separate slices, per epic #271):**
- `migration-status` collection + the fleet schema-migration runner (batch/lazy/staged rollout, `minSchemaVersion` guard).
- `deployment-events` retention/compaction (depends on the dim11 compaction primitive, not yet built).
- `blob-catalog` (open epic question; not part of this slice).
- Insight Vault / `withCrossVaultDerivation` (Layer 2; gated on a separate cross-vault DEK-grant design).

## Decisions (locked during brainstorming)

1. **Scope:** registry + schema-manifest + deployment-events. Migration-status + runner deferred.
2. **Registry authority:** authoritative + auto-wired. `createShard` writes the row; the registry IS the shard list (portable, works on every backend). `listAccessibleVaults()` becomes an optional cross-check/drift reconcile where the backend supports it. Backward-compatible: an explicit `registry:` is still honored.
3. **Schema manifest:** per-`(templateName, version)` blueprint (collections + index defs) **plus** a deterministic fingerprint over the serializable subset only.
4. **Packaging:** a dedicated `StateManagementVault` class (Approach A), not loose helpers or a fold into `VaultGroup`. The state vault is fleet-wide and outlives any one group.

## Architecture

```
Noydb instance (one credential resolver)
│
├── openVaultGroup(name)                    ← auto-opens the state vault when registry omitted
│      └── VaultGroup  (routing; unchanged)
│
└── StateManagementVault                    ← reserved vault __noydb_state__
       (opened via this.openVault(), same keyring path as every vault)
       ├── registry          Collection<VaultRegistryRow>    (authoritative shard list)
       ├── schemaManifest     Collection<SchemaManifestRow>   (per-version blueprint + fingerprint)
       └── deploymentEvents   Collection<DeploymentEvent>     (append-only; accessor-enforced, optional immutableGuard)
```

**One reserved state vault per `Noydb` instance, not per group.** The state vault is fleet-wide (`__noydb_state__`). Its registry rows are discriminated by a new `group` field so a single control plane can serve multiple `VaultGroup`s. This matches the epic's "StateManagement Vault" framing as a single control plane and lets it outlive any one group.

**Registry record-id qualification (collision fix).** Today `createShard` keys the registry by bare `partitionKey` (`registry.put(partitionKey, …)`, `vault-group.ts:104`). With a single shared registry collection across multiple groups, two groups using the same partition key would collide on the same record id. The registry record id is therefore **group-qualified**: `\`${group}--${partitionKey}\`` (the `--` separator is already reserved and rejected inside both group names and partition keys, so the composite is unambiguous). The shipped `VaultGroup` methods that call `registry.get(partitionKey)` / `registry.put(partitionKey, …)` (`createShard`, `shard`, `ShardedCollection.put`) change to a private `registryId(partitionKey)` helper. When a caller passes an explicit `registry`, the same qualification applies (the `group` is `this.name`).

## Components

- **`StateManagementVault`** (new, `packages/hub/src/federation/state-vault.ts`) — wraps the reserved vault, lazily + idempotently configures the three collections, exposes typed accessors (`.registry`, `.schemaManifest`, `.deploymentEvents`). Single owner for all control-plane reads/writes.
- **`openVaultGroup` wiring** (`noydb.ts`) — when `opts.registry` is omitted, auto-open the state vault and use `stateVault.registry`; when provided, honor it verbatim (backward-compat).
- **`createShard` / provisioning** (`vault-group.ts`) — already writes registry rows; gains a best-effort `deploymentEvents` append (`shard-created`) and ensures the manifest row for the template version exists.
- **`withVaultTemplate` registration** (`noydb.ts:1006`) — runs `template.configure` against a throwaway probe vault to extract the serializable blueprint and compute the manifest fingerprint.

## Data model

`VaultRegistryRow` exists today (`packages/hub/src/federation/types.ts:26`); add a `group` discriminator:

```ts
interface VaultRegistryRow {            // EXISTING + group
  vaultId: string
  partitionKey: string
  templateName: string
  schemaVersion: number
  createdAt: number
  group: string                          // NEW — which VaultGroup this shard belongs to
}

interface SchemaManifestRow {            // NEW — keyed by (templateName, version)
  templateName: string
  version: number
  collections: string[]                  // serializable blueprint
  indexes: Record<string, IndexDef[]>    // per-collection index defs (serializable)
  fingerprint: string                    // sha256 over the serializable subset only
  recordedAt: number
}

interface DeploymentEvent {              // NEW — append-only (accessor-enforced)
  id: string
  ts: number
  type: 'shard-created' | 'manifest-recorded' | 'group-opened'
  group: string
  vaultId?: string
  templateName?: string
  version?: number
  actor?: string                          // from the unlocked keyring identity — DEFERRED: not populated in v1 (optional field, wired in a later slice)
}
```

## Schema manifest fingerprint mechanism

The fingerprint must be deterministic across processes, so it can only hash serializable bytes.

1. At `withVaultTemplate(name, template)` registration (where `template: VaultTemplate = { version, configure }`, `types.ts:20`), run `template.configure` once against a throwaway **probe vault** (in-memory, unencrypted; never persisted).
2. `Collection.name` and `Collection.indexes` are private, so the blueprint is captured by a **recording proxy** around the probe vault that intercepts `collection(name, opts)` calls — recording `{ name, indexes: opts?.indexes ?? [], persistJsonSchema: !!opts?.persistJsonSchema }` — and delegates to the real vault method so any other `configure` calls still execute. This captures exactly what the template *declares*, deterministically.
3. Canonicalize (sort collections by name, sort index defs by key, stable JSON) → `sha256` → `fingerprint`.

**v1 fingerprint surface:** collection names + index defs + the `persistJsonSchema` boolean flag per collection. Hashing the JSON-Schema *body* (via `zod-to-json-schema`) is a deferred refinement — the flag captures "schema persistence was declared" without the serialization complexity. This keeps v1 fully deterministic and is consistent with the determinism boundary below.

```
configure(probeVault) ──▶ { collections, indexes, jsonSchema? }
                          └─ canonical-JSON ─▶ sha256 ─▶ fingerprint
```

**Determinism boundary (explicit).** Raw Zod/StandardSchema validators and computed-field closures are **out of the fingerprint** — they cannot be hashed deterministically across processes (the codebase already treats persisted JSON Schema as opt-in, `vault.ts:581`). Consequence: **validator/computed-field changes within the same declared `version` are not drift-detected.** Bumping `version` is the contract for "the shape changed." This is documented as a known limitation, not a bug.

**Drift detection.** Compare the fingerprint of a `template`'s current declared shape to the stored manifest for `(templateName, version)`; mismatch on the serializable surface ⇒ drift. Because shards carry no schema state independent of their template (every shard is configured by re-running `template.configure`), what this actually catches is **"a template's shape changed without bumping `version`"** — not independent per-shard drift. That is the useful, realizable semantics here; true shard-level introspection would require reading each shard's persisted schema and is out of scope for this slice (and for the migration-runner slice to revisit). A missing manifest is treated as drift. Surfaced via `detectDrift()` and composable with the existing `SkippedVault{ reason: 'schema-drift' }` path (`types.ts:62`).

## Auto-wire, key source & backward-compat

- **Reserved name:** `__noydb_state__`. Validated unreachable as a shard id — the `__…__` prefix is reserved and rejected for user vault + partition keys (extends `assertSafePartitionKey`, `vault-group.ts:33`).
- **Key source:** `StateManagementVault` is opened with `this.openVault('__noydb_state__')` → `getKeyringInternal` → the **same instance-level credential resolver** (passphrase / getKeyring callback) that unlocks every other vault. No new key concept; if the instance can open shards, it can open the state vault.
- **Bundle isolation:** the `StateManagementVault` class (and `schema-manifest.ts`) must stay in the dynamically-`import()`-ed federation chunk, not the eager core graph (`noydb.ts:1019` already `import()`s `VaultGroup` for this reason). The reserved-name constant `STATE_VAULT_NAME` therefore lives in a **zero-dependency core leaf** (`federation/constants.ts`, no imports) so `noydb.ts` can reference it statically without pulling `state-vault.js`/`schema-manifest.js` into core. The constant is imported *by* `state-vault.ts`, never the reverse.
- **API change (backward-compatible):** `VaultGroupOptions.registry` becomes **optional**.
  - omitted → auto-open `__noydb_state__`, use its `registry` accessor.
  - provided → use the caller's collection verbatim (existing tests keep passing; manifest/events accessors are unavailable on that opted-out path).
- **Idempotent bootstrap:** opening the state vault configures the three collections if absent; safe to call repeatedly (mirrors `createShard`'s row+vault idempotency, `vault-group.ts:85`).

## Deployment events (append-only) & retention

**Mechanism note.** The physical control-plane collections are named `vaultRegistry`, `schemaManifest`, and `deploymentEvents` (single-token camelCase, to stay clear of any collection-name charset rules — the kebab-case names used in this doc's prose are conceptual labels only). `immutableGuard` is an *instance-level* `guardStrategies` config fixed at `createNoydb()` time and applied vault-wide by collection name (`noydb.ts:#registerGuardGate` / `_initGuards`); there is **no runtime per-vault guard registration**. So `StateManagementVault` cannot auto-apply a WORM guard to its own `deploymentEvents` collection from inside the abstraction. Append-only is therefore enforced at the **accessor level**:

- `StateManagementVault` exposes `deploymentEvents` mutation only through an `appendEvent(event)` method that `put`s a fresh unique-id record; it never exposes update/delete. The raw collection is not surfaced.
- **Optional hardening:** a consumer who wants cryptographically-enforced WORM can add `immutableGuard({ collection: 'deploymentEvents', appendOnly: true })` to their own `createNoydb({ guardStrategies })` (note the exact physical collection name `deploymentEvents`); because the state vault is opened by the same instance, the guard then applies. This is documented as opt-in, not required.
- Events written at: shard creation, manifest recording, group open.
- **Best-effort and non-fatal:** a failed event append logs but does not fail the underlying op (the registry write is the authoritative action; the event is observability).
- **Retention is out of scope** for this slice (epic open question — unbounded growth depends on the dim11 compaction primitive). Documented as a deferred follow-up; at pilot scale the log is small.

## Error handling

- **`__noydb_state__` collision** — reject any attempt to use it as a group name or partition key (extends the reserved-token checks in `assertSafePartitionKey`).
- **Registry/vault drift** — row present, vault gone → existing `ShardProvisioningError`, reused unchanged.
- **Manifest absent for a claimed version** — treated as `schema-drift`, not a crash; the fan-out `minVersion` guard already skips such shards.
- **Event-append failure** — swallowed (logged), never propagates.
- **Explicit-registry mode** — if a caller passes `registry`, no state vault is opened; manifest/events accessors are unavailable (documented opt-out).

## Testing

- **Unit:** accessor idempotency; reserved-name rejection; fingerprint determinism (same `configure` ⇒ same hash across two probe runs; collection/index change ⇒ different hash; validator-only change ⇒ **same** hash, asserting the documented boundary).
- **Integration:** `openVaultGroup(name)` with no `registry` auto-opens `__noydb_state__`; `createShard` writes a registry row + `shard-created` event + ensures a manifest row; drift test (shard shape ≠ claimed version ⇒ `schema-drift` skip).
- **Backward-compat:** existing `federation-*.test.ts` passing an explicit `registry` still pass untouched.
- **Append-only:** `StateManagementVault` exposes no update/delete for events (only `appendEvent`); a test asserts the accessor surface is append-only, and a separate test confirms that when a consumer adds the optional `immutableGuard`, mutation rejects with `RecordLockedError`.

## features.yaml

A registry entry for the StateManagement Vault control-plane capability is mandatory before code lands (CI "Spec coverage" gate), linking this spec to the new `state-vault.ts` artefact and the federation showcase.

## Out-of-scope boundary notes (carried from epic #271)

- `crossShardJoin` remains a separate slice (programmatic API on the `partitionScope:'all'` seam).
- `migration-status` + fleet migration runner is the natural next Layer-3 slice, building on `packages/hub/src/schema-update/` and this manifest.
- Insight Vault (`withCrossVaultDerivation`) is gated on its own cross-vault DEK-grant design.
