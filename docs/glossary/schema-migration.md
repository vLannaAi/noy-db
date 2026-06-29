# Schema migration vocabulary

Canonical terms for evolving data schemas across the **noy-db (vault) ↔ klum-db (lobby)** boundary. This is shared vocabulary — the same file lives in both repos; keep the copies in sync.

## The ladder

Three nested concepts. Compose them as one sentence:

> A **Rollout** applies a **Transform** to a vault group by performing a **Cutover** on each member vault.

### Transform — *(noy-db)*
A pure, deterministic function mapping **one decrypted record** from schema generation *N* → *N+1*. No I/O, no coordination, no cross-record or cross-vault awareness. The unit of change.
- **Lineage:** the "T" in ETL; an Avro/Protobuf schema-evolution upgrade function; the body of a Rails/Flyway/Alembic migration.
- **Code:** `TransformFn` / the `transform` passed to the `coordinatedCutover` strategy.
- **Owner:** noy-db — it runs on decrypted records, so it's crypto-bound.

### Cutover — *(noy-db)*
The coordinated, **in-place** transition of **one vault** from generation *N* → *N+1*: raise a drain fence → quiesce all live clients to a barrier (or time out) → apply the Transform → atomically bump the vault's generation. Multi-client by construction; **indivisible from the vault's write-queue and write-gate**.
- **Lineage:** a "cutover" (the controlled switch); the live phase of an online schema change (gh-ost / pt-osc); quiesce / drain / fence / barrier from distributed systems.
- **Code:** `vault.runSchemaCutover()`, driven by `SchemaFenceController` (the fence state machine: `normal → draining → migrating → complete`).
- **Owner:** noy-db — it's concurrency control for one vault, which cannot be split from that vault's write path.

### Rollout — *(klum-db)*
The orchestration of a Cutover across a **set of one-or-more vaults** (a group / fleet): select eligible members, sequence, track per-vault status, emit lifecycle events, retry, roll back partial progress. Coordinates across the **vault boundary**; delegates each vault's Cutover to that vault.
- **Lineage:** a "rolling rollout / upgrade" (Kubernetes); fleet-wide migration; phased rollout.
- **Code:** `VaultGroup.rolloutSchema()` (the fleet) / `cutoverShard()` (one shard) — in `@klum-db/lobby`.
- **Owner:** klum-db — coordination across multiple vaults is the Lobby's job.

## Strategy axis (orthogonal to the ladder)

*How* a Cutover/Rollout reshapes data is a separate dimension:

| Strategy | Industry term | What it does | Falls under |
|---|---|---|---|
| **In-place** | online schema change | Mutate the existing vault behind the fence (current model) | Cutover → noy-db |
| **Expand–Contract** | Parallel Change (Fowler) | Add the new shape additively, dual-write / backfill, then drop the old — within a vault | Cutover (multi-step) → noy-db |
| **Blue-Green** | blue-green migration | New-schema vault, transform-copy across, flip clients, retire old | Rollout → klum-db (cross-vault by construction) |

## Boundary rule

**Transform + Cutover = noy-db** (one vault's data + concurrency control, indivisible from the write path). **Rollout = klum-db** (coordination across the vault boundary). "Schema migration" is the informal umbrella for the whole activity — *not* a precise rung; don't use it as a tier label.
