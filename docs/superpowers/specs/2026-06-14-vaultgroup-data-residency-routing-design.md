# VaultGroup data-residency routing constraint (#271)

> **Status:** ACCEPTED + BUILT (0.2.0-pre.19 cycle) — shipped recommendation
> 1 + 2 (advisory `StoreCapabilities.region` + `sharding.regionOf` placement
> guard + `DataResidencyError` + `RoutedNoydbStore.resolveBackend`) and
> documented 3 (region-encoded partition-key convention). The `shardKey` helper
> remains optional/deferred.
> **Context:** the epic flags data-residency (dim11's `region` idea) as an
> undesigned dependency for regulated MVF deployments. This scopes how a
> `VaultGroup` routes each shard to a region-appropriate backend and refuses
> non-compliant placement.

## Problem

A regulated firm (GDPR, data locality) must keep a client's shard vault on a
backend in a specific region — `acme` → EU store, `globex` → US store. Today a
`VaultGroup` provisions and reads every shard through the **single** store on
its `Noydb` (`this.db.options.store`). There is no per-shard backend selection
and no way to *enforce* that a shard lands on a region-correct backend.

## Current state (grounded)

- **One store per `Noydb`.** All vaults (shards, state vault, Insight Vault) go
  through `options.store` (`noydb.ts`).
- **But the routing seam already exists.** `routeStore({ vaultRoutes: { 'EU-':
  euStore, 'US-': usStore }, default })` multiplexes by **vault-name prefix**
  (`store/route-store.ts:112` — "Route by vault name (prefix patterns, e.g.
  `'EU-'`"). Since a shard's vault id is `${group}--${partitionKey}`, a
  region-encoding partition key (`eu-acme` → `firm--eu-acme`) already routes to
  the right regional backend via a `vaultRoutes` prefix (`firm--eu-`).
- **No `region` capability.** `StoreCapabilities` (`types.ts:1641`) has no
  `region` field, so a misconfigured route — a shard physically landing on the
  wrong-region backend — cannot be *detected*. Residency today is achievable but
  **unenforced** (operator must wire `vaultRoutes` correctly by hand).

So the gap is **enforcement**, not raw capability: prevent a shard from being
created/written on a backend whose region doesn't match the record's required region.

## Decision

Three layered, independently-shippable pieces; decide how far to go.

### 1. `region` store capability (advisory) — recommend YES

Add `readonly region?: string` to `StoreCapabilities`. Adapters/`routeStore`
declare the region a store serves (`{ region: 'eu' }`). Purely advisory until a
consumer enforces it; zero behavior change for stores that omit it.

### 2. `VaultGroup` placement guard — recommend YES

Add `sharding.regionOf?: (record: T) => string`. On `createShard` (and the
routing `put` that auto-creates), the group resolves the candidate backend for
the shard's vault id and compares its declared `capabilities.region` to
`regionOf(record)`; on mismatch it throws **`DataResidencyError`** *before*
provisioning — so a shard never lands on a non-compliant backend.

Resolving "the candidate backend for a vault id": ask the (possibly routed)
store which backend a vault id maps to. `RoutedNoydbStore` can expose a
`resolveBackend(vaultId): NoydbStore` (it already computes this internally for
`vaultRoutes`); a plain store resolves to itself. The guard reads
`resolveBackend(shardVaultId).capabilities?.region`.

Reads are unaffected — fan-out already hits whatever backend the route picks;
the constraint is about *placement* (and a loud failure if naming/routing drift
apart).

### 3. Region-encoded partitioning convention — recommend DOCUMENT

The cleanest way for `vaultRoutes` to route shards by region is a
region-segment in the partition key (`eu-acme`, `us-globex` — within the
existing `[A-Za-z0-9._-]` charset), so `firm--eu-` / `firm--us-` prefixes route.
Document this convention; optionally let `sharding.regionOf` + a
`sharding.shardKey(region, key)` helper compose the name so naming and routing
can't drift. *Rec: document the convention now; the helper is optional sugar.*

## Open dependencies / non-goals (v1)

- **Multi-backend wiring stays the operator's job** via `routeStore`. The hub
  adds the *capability* + the *guard*; it does not manage regional connections.
- **Moving an existing shard between regions** (re-homing) is out of scope —
  that's an `extractPartition` → re-`adoptPartition`-on-regional-store ceremony
  (#198), not a routing change.
- **Reads from the wrong region** aren't blocked by this design (the route
  already determines the physical backend); the guard prevents wrong-region
  *placement*, which is the compliance-relevant event.
- **Per-region keyrings / cross-region grants** are unchanged (each shard keeps
  its own DEK boundary regardless of region).

## Recommendation summary

Ship **1 + 2** (advisory `region` capability + `regionOf` placement guard +
`DataResidencyError`) and **document 3**. This makes residency *enforceable* on
top of the existing `routeStore` seam without the hub taking on connection
management. If even that is more than wanted now, the minimum viable answer is
**"residency = `routeStore({ vaultRoutes })` + a region-encoded partition key;
enforcement is a documented follow-up"** — i.e. document-only, no code.

## Build (if 1+2 approved)

- `StoreCapabilities.region?: string` (`types.ts`) + thread it through
  `routeStore` (a routed store reports the region of its `default`, or per-route).
- `RoutedNoydbStore.resolveBackend(vaultId)` (expose existing internal mapping).
- `ShardingConfig.regionOf?` (`federation/types.ts`); `createShard` placement
  check + `DataResidencyError` (`errors.ts`).
- Tests: mismatch throws on create; matching create succeeds; no `regionOf` →
  unchanged. Showcase: EU/US split via `routeStore` + `regionOf`.
- Docs: residency section in `docs/subsystems/vault-group.md`.
