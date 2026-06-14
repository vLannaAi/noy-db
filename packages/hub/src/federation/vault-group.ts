/**
 * @category capability
 * Multi-vault partition federation — VaultGroup transparent shard
 * routing. Spec:
 * docs/superpowers/specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md.
 */
import type { Noydb } from '../noydb.js'
import type { Vault } from '../vault.js'
import type { Collection } from '../collection.js'
import { StateManagementVault } from './state-vault.js'
import { CrossShardJoinError, ReservedVaultNameError, ShardProvisioningError, UnknownShardError, ValidationError } from '../errors.js'
import { STATE_VAULT_NAME } from './constants.js'
import { classifyShardSkip } from './classify-skip.js'
import { applyBroadcastLegs } from './cross-shard-join.js'
import type { CoPartitionedLeg, BroadcastLeg, CrossShardJoinOptions, BroadcastJoinOptions } from './cross-shard-join.js'
import { CrossVaultLive } from './cross-vault-live.js'
import { CrossVaultAggregation, CrossVaultGroupedAggregation } from './aggregate-across.js'
import type { FanoutRecordSource, LiveBinding } from './aggregate-across.js'
import type { AggregateSpec } from '../aggregate/aggregation.js'
import type {
  ShardingConfig,
  VaultRegistryRow,
  VaultTemplate,
  FanoutQueryOptions,
  FanoutResult,
  SkippedVault,
  WhereClause,
  LiveQueryOptions,
  CrossVaultLiveQuery,
  CrossVaultDerivationSpec,
  CrossVaultDerivationContext,
  RefreshInsightsResult,
  MigrationStatusRow,
  FleetMigrationResult,
} from './types.js'

/** Reserved separator between group name and partition key in a shard vault id. */
const SHARD_SEPARATOR = '--'
/** Store-safe partition-key charset (single hyphens OK; '--' is the reserved separator). */
const SAFE_PARTITION_KEY = /^[A-Za-z0-9._-]+$/

function assertSafePartitionKey(partitionKey: string): void {
  if (partitionKey.length === 0) {
    throw new ValidationError('partitionKey must be a non-empty string')
  }
  if (partitionKey === STATE_VAULT_NAME) {
    throw new ReservedVaultNameError(partitionKey)
  }
  if (!SAFE_PARTITION_KEY.test(partitionKey)) {
    throw new ValidationError(
      `partitionKey "${partitionKey}" contains characters outside [A-Za-z0-9._-]. ` +
        `Map your records to a store-safe key in sharding.keyOf.`,
    )
  }
  if (partitionKey.includes(SHARD_SEPARATOR)) {
    throw new ValidationError(
      `partitionKey "${partitionKey}" must not contain "--" — it is reserved as the ` +
        `shard vault-id separator and would risk shard-id collisions.`,
    )
  }
}

export class VaultGroup<T> {
  constructor(
    /** @internal */ readonly db: Noydb,
    /** @internal */ readonly name: string,
    /** @internal */ readonly registry: Collection<VaultRegistryRow>,
    /** @internal */ readonly sharding: ShardingConfig<T>,
    /** @internal */ readonly template: VaultTemplate,
    /** @internal — lazy migrate-on-open (#271). */ readonly migrateOnOpen: boolean = false,
  ) {
    if (name.includes(SHARD_SEPARATOR)) {
      throw new ValidationError(
        `VaultGroup name "${name}" must not contain "--" (reserved shard vault-id separator).`,
      )
    }
  }

  /** @internal — set when the group is managed (no explicit registry). */
  private stateVault: StateManagementVault | undefined

  /** @internal */
  _attachStateVault(sv: StateManagementVault): void {
    this.stateVault = sv
  }

  /** Deterministic vault name for a partition key, namespaced by the group. */
  shardVaultId(partitionKey: string): string {
    assertSafePartitionKey(partitionKey)
    return `${this.name}${SHARD_SEPARATOR}${partitionKey}`
  }

  /**
   * @internal — group-qualified registry record key (avoids cross-group key
   * collisions). Identical to the shard vault id by design — the registry row
   * for a shard is keyed by that shard's vault id — so it delegates to
   * `shardVaultId`, reusing its partition-key validation.
   */
  registryId(partitionKey: string): string {
    return this.shardVaultId(partitionKey)
  }

  /**
   * Registry rows for THIS group (hydrates the registry collection first).
   * The registry may be shared across groups (the auto-wired StateManagement
   * vault holds one `vaultRegistry` for the whole instance), so rows are
   * filtered by `group` — without this, a group's fan-out reads would leak
   * across into other groups' shards. Mirrors the `${group}--` scoping that
   * `liveBinding().isRelevant` already applies to the reactive path.
   */
  async allRows(): Promise<VaultRegistryRow[]> {
    await this.registry.list()
    const rows = this.registry.query().toArray() // toArray() is synchronous
    return rows.filter((r) => r.group === this.name)
  }

  /**
   * Open an existing shard and apply the template. When `migrateOnOpen` is set
   * (#271) and the shard's registry version is behind the template, its cutover
   * runs inline first — so a behind shard never surfaces a stale handle.
   */
  async openShard(partitionKey: string): Promise<Vault> {
    if (this.migrateOnOpen) {
      const row = await this.registry.get(this.registryId(partitionKey))
      if (row && row.schemaVersion < this.template.version) {
        await this.migrateShard(partitionKey)
      }
    }
    return this._openShardRaw(partitionKey)
  }

  /** @internal — open + configure with no migrate-on-open hook (used by the migration path itself to avoid recursion). */
  private async _openShardRaw(partitionKey: string): Promise<Vault> {
    const vault = await this.db.openVault(this.shardVaultId(partitionKey), { create: false })
    this.template.configure(vault)
    return vault
  }

  /**
   * Idempotently provision a shard for `partitionKey`. Returns the
   * configured vault handle.
   *
   * - row + vault present → no-op, return handle
   * - row present, vault gone → ShardProvisioningError
   * - row absent (vault present or not) → open-or-create, configure, write row
   */
  async createShard(partitionKey: string): Promise<Vault> {
    const vaultId = this.shardVaultId(partitionKey)
    const row = await this.registry.get(this.registryId(partitionKey))
    const provisioned = await this.db._shardVaultProvisioned(vaultId)

    if (row && !provisioned) throw new ShardProvisioningError(vaultId, partitionKey)
    if (row && provisioned) return this.openShard(partitionKey)

    // Row absent → create (or reconcile a provisioned-but-unregistered vault).
    const vault = await this.db.openVault(vaultId)
    this.template.configure(vault)
    await this.registry.put(this.registryId(partitionKey), {
      vaultId,
      partitionKey,
      templateName: this.sharding.vaultTemplate,
      schemaVersion: this.template.version,
      createdAt: Date.now(),
      group: this.name,
    })
    if (this.stateVault) {
      try {
        await this.stateVault.appendEvent({
          type: 'shard-created',
          group: this.name,
          vaultId,
          templateName: this.sharding.vaultTemplate,
          version: this.template.version,
        })
      } catch {
        /* best-effort: event logging never fails the shard write */
      }
    }
    return vault
  }

  /**
   * Drill down to a single shard's full Collection API. Throws if the shard is unknown.
   * Also throws ShardProvisioningError if the registry row exists but the vault has been deleted
   * (registry/store divergence).
   */
  async shard(partitionKey: string): Promise<Vault> {
    const vaultId = this.shardVaultId(partitionKey)
    const row = await this.registry.get(this.registryId(partitionKey))
    if (!row) throw new UnknownShardError(partitionKey, this.name)
    const provisioned = await this.db._shardVaultProvisioned(vaultId)
    if (!provisioned) throw new ShardProvisioningError(vaultId, partitionKey)
    return this.openShard(partitionKey)
  }

  /** A sharded view over one logical collection across all shards. */
  collection<R = T>(collectionName: string): ShardedCollection<T, R> {
    return new ShardedCollection<T, R>(this, collectionName)
  }

  /** @internal — eligible (openable-candidate) rows + drift/divergence skips. */
  async resolveEligible(options: { minVersion?: number } = {}): Promise<{
    eligible: VaultRegistryRow[]
    skipped: SkippedVault[]
  }> {
    const rows = await this.allRows()
    const skipped: SkippedVault[] = []
    const versionOk: VaultRegistryRow[] = []
    for (const row of rows) {
      if (options.minVersion !== undefined && row.schemaVersion < options.minVersion) {
        skipped.push({ vaultId: row.vaultId, reason: 'schema-drift' })
      } else versionOk.push(row)
    }
    const provisioned = await Promise.all(versionOk.map((r) => this.db._shardVaultProvisioned(r.vaultId)))
    const eligible: VaultRegistryRow[] = []
    versionOk.forEach((row, i) => {
      if (provisioned[i]) eligible.push(row)
      else skipped.push({ vaultId: row.vaultId, reason: 'error', error: new ShardProvisioningError(row.vaultId, row.partitionKey) })
    })
    return { eligible, skipped }
  }

  /** @internal — registered push-model cross-vault derivations (#271 Insight Vault). */
  private readonly crossVaultDerivations: CrossVaultDerivationSpec[] = []

  /**
   * Register a push-model cross-vault derivation — the Insight Vault pattern
   * (#271, Layer 4). Drive it with {@link refreshInsights}.
   *
   * For each shard, `derive(records, ctx)` runs on that shard's `source`
   * records and its return value is written into the analytics
   * (`target.vault` / `target.collection`) vault, keyed by partition key —
   * one summary row per shard. The derivation runs in-process under THIS
   * group's `Noydb` (which already holds both the shard and Insight Vault
   * keyrings); the shard's decrypted records are reduced to a summary that is
   * re-encrypted under the Insight Vault's own DEK, so no shard ciphertext
   * crosses a DEK boundary.
   *
   * **Zero-knowledge note:** the Insight Vault backend sees aggregated
   * structure (totals, counts, timestamps) drawn from many shards — a weaker
   * ZK profile than the per-shard vaults. Opt-in; keep summaries to aggregate
   * scalars (no embeddings / no raw records).
   *
   * v1 is explicit-refresh (no write-path push); call `refreshInsights()`
   * after a batch of writes, or on a schedule.
   */
  withCrossVaultDerivation<R = Record<string, unknown>, S = Record<string, unknown>>(
    spec: CrossVaultDerivationSpec<R, S>,
  ): void {
    this.crossVaultDerivations.push(spec as unknown as CrossVaultDerivationSpec)
  }

  /**
   * Run every registered {@link withCrossVaultDerivation}: read each eligible
   * shard's source records, derive a per-shard summary, and write it into the
   * Insight Vault keyed by partition key. Shards behind `minVersion`,
   * unprovisioned, or whose read errors are reported in `skippedVaults` and
   * are not written (a stale summary is never left behind for a failed shard).
   */
  async refreshInsights(options: { minVersion?: number; concurrency?: number } = {}): Promise<RefreshInsightsResult> {
    if (this.crossVaultDerivations.length === 0) return { written: 0, skippedVaults: [] }
    const { eligible, skipped } = await this.resolveEligible(
      options.minVersion !== undefined ? { minVersion: options.minVersion } : {},
    )
    let written = 0
    for (const spec of this.crossVaultDerivations) {
      const results = await this.db.queryAcross<Record<string, unknown>[]>(
        eligible.map((r) => r.vaultId),
        async (vault) => {
          this.template.configure(vault)
          return vault.collection<Record<string, unknown>>(spec.source).list()
        },
        { create: false, ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}) },
      )
      const insight = await this.db.openVault(spec.target.vault)
      const out = insight.collection<Record<string, unknown>>(spec.target.collection)
      for (let i = 0; i < eligible.length; i++) {
        const row = eligible[i]!
        const res = results[i]
        if (!res || res.result === undefined) {
          skipped.push({ vaultId: row.vaultId, reason: 'error', ...(res?.error ? { error: res.error } : {}) })
          continue
        }
        const ctx: CrossVaultDerivationContext = {
          vaultId: row.vaultId,
          partitionKey: row.partitionKey,
          schemaVersion: row.schemaVersion,
        }
        const summary = spec.derive(res.result, ctx)
        await out.put(row.partitionKey, summary)
        written++
      }
    }
    return { written, skippedVaults: skipped }
  }

  /** @internal — the control-plane vault for migration status; lazily opened. */
  private async ensureStateVault(): Promise<StateManagementVault> {
    if (!this.stateVault) this.stateVault = await StateManagementVault.open(this.db)
    return this.stateVault
  }

  /**
   * Migrate ONE shard to the template's current version (#271 fleet runner,
   * per-shard step). Opens the shard (applying the template, which arms the
   * M12 cutover), drains schema-write detection, runs `vault.runSchemaCutover()`
   * (the per-vault drain-barrier-transform protocol), then advances the
   * registry row's `schemaVersion` and records `migration-status`. A shard
   * already at the template version is a no-op (`status: 'done'`, migrated 0).
   * Never throws on a cutover failure — it records `status: 'failed'` and
   * returns the row, so a fleet run continues past a bad shard.
   */
  async migrateShard(partitionKey: string): Promise<MigrationStatusRow> {
    const vaultId = this.shardVaultId(partitionKey)
    const row = await this.registry.get(this.registryId(partitionKey))
    if (!row) throw new UnknownShardError(partitionKey, this.name)
    const target = this.template.version
    const sv = await this.ensureStateVault()
    const base = { vaultId, group: this.name, currentVersion: row.schemaVersion, targetVersion: target }

    if (row.schemaVersion >= target) {
      const done: MigrationStatusRow = { ...base, status: 'done', migrated: 0, finishedAt: Date.now() }
      await sv.upsertMigrationStatus(done)
      return done
    }

    await sv.upsertMigrationStatus({ ...base, status: 'running', startedAt: Date.now() })
    try { await sv.appendEvent({ type: 'migration-started', group: this.name, vaultId, version: target }) } catch { /* best-effort */ }

    try {
      const vault = await this._openShardRaw(partitionKey)
      await vault._drainPendingSchemaWrites()
      const { migrated } = await vault.runSchemaCutover()
      // Advance the authoritative registry version (no built-in update path).
      await this.registry.put(this.registryId(partitionKey), { ...row, schemaVersion: target })
      const done: MigrationStatusRow = { ...base, currentVersion: target, status: 'done', migrated, finishedAt: Date.now() }
      await sv.upsertMigrationStatus(done)
      try { await sv.appendEvent({ type: 'migration-completed', group: this.name, vaultId, version: target }) } catch { /* best-effort */ }
      return done
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const failed: MigrationStatusRow = { ...base, status: 'failed', error, finishedAt: Date.now() }
      await sv.upsertMigrationStatus(failed)
      try { await sv.appendEvent({ type: 'migration-failed', group: this.name, vaultId, version: target, detail: error }) } catch { /* best-effort */ }
      return failed
    }
  }

  /**
   * Active batch runner (#271): migrate every shard behind the template version
   * to it, in controlled batches. **Resumable + crash-safe** — shards already at
   * the target are skipped (the registry version is the source of truth), so a
   * re-run after a crash only picks up the unfinished + previously-failed shards.
   *
   * - `cohort` — restrict to these partition keys (the staged / canary rollout:
   *   migrate a small cohort, verify the Insight Vault, then run the rest).
   * - `batchSize` — max shards migrated concurrently per batch (back-pressure).
   *   Default 4. Batches run sequentially; shards within a batch run in parallel.
   */
  async migrateFleet(options: { cohort?: readonly string[]; batchSize?: number } = {}): Promise<FleetMigrationResult> {
    const target = this.template.version
    const rows = await this.allRows()
    const cohort = options.cohort
    const todo = rows.filter(
      (r) => r.schemaVersion < target && (cohort === undefined || cohort.includes(r.partitionKey)),
    )
    const batchSize = Math.max(1, options.batchSize ?? 4)
    const migrated: string[] = []
    const failed: { vaultId: string; error: string }[] = []
    for (let i = 0; i < todo.length; i += batchSize) {
      const batch = todo.slice(i, i + batchSize)
      const settled = await Promise.all(batch.map((r) => this.migrateShard(r.partitionKey)))
      for (const res of settled) {
        if (res.status === 'done') migrated.push(res.vaultId)
        else failed.push({ vaultId: res.vaultId, error: res.error ?? 'unknown' })
      }
    }
    return { target, migrated, failed }
  }
}

export class ShardedCollection<T, R = T> {
  constructor(
    private readonly group: VaultGroup<T>,
    private readonly collectionName: string,
  ) {}

  /** Route a write to the shard owning `keyOf(record)`. */
  async put(id: string, record: T): Promise<void> {
    const key = this.group.sharding.keyOf(record)
    const row = await this.group.registry.get(this.group.registryId(key))
    let vault: Vault
    if (!row) {
      if (this.group.sharding.autoCreate === false) {
        throw new UnknownShardError(key, this.group.name)
      }
      vault = await this.group.createShard(key)
    } else {
      vault = await this.group.openShard(key)
    }
    await vault.collection<T>(this.collectionName).put(id, record)
  }

  /** Begin a cross-shard fan-out query. */
  query(): ShardedQuery<T, R> {
    return new ShardedQuery<T, R>(this.group, this.collectionName, [])
  }
}

export class ShardedQuery<T, R = T> {
  constructor(
    private readonly group: VaultGroup<T>,
    private readonly collectionName: string,
    private readonly clauses: readonly WhereClause[],
    private readonly coPartitionedLegs: readonly CoPartitionedLeg[] = [],
    private readonly broadcastLegs: readonly BroadcastLeg[] = [],
  ) {}

  where(field: string, op: WhereClause['op'], value: unknown): ShardedQuery<T, R> {
    return new ShardedQuery<T, R>(
      this.group,
      this.collectionName,
      [...this.clauses, { field, op, value }],
      this.coPartitionedLegs,
      this.broadcastLegs,
    )
  }

  /** Co-partitioned join: each shard joins its own same-vault right collection (resolved via ref()), then union. */
  crossShardJoin(field: string, opts: CrossShardJoinOptions): ShardedQuery<T, R> {
    const leg: CoPartitionedLeg = { field, as: opts.as, maxRows: opts.maxRows, strategy: opts.strategy }
    return new ShardedQuery<T, R>(
      this.group,
      this.collectionName,
      this.clauses,
      [...this.coPartitionedLegs, leg],
      this.broadcastLegs,
    )
  }

  /** Broadcast dimension join: enrich every merged row from a single shared collection. */
  broadcastJoin(field: string, opts: BroadcastJoinOptions): ShardedQuery<T, R> {
    const leg: BroadcastLeg = {
      field,
      as: opts.as,
      from: opts.from,
      on: opts.on ?? 'id',
      mode: opts.mode ?? 'warn',
    }
    return new ShardedQuery<T, R>(
      this.group,
      this.collectionName,
      this.clauses,
      this.coPartitionedLegs,
      [...this.broadcastLegs, leg],
    )
  }

  /** @internal — fan out the where-filtered records across eligible shards. */
  async fanoutRecords(options: FanoutQueryOptions = {}): Promise<{ records: R[]; skippedVaults: SkippedVault[] }> {
    const { eligible, skipped } = await this.group.resolveEligible(options)
    // Deterministic pre-check: an undeclared co-partitioned join ref fails
    // identically on every shard, so surface it as ONE CrossShardJoinError
    // rather than N identical skips. Probe the first eligible shard.
    const probeRow = eligible[0]
    if (this.coPartitionedLegs.length > 0 && probeRow) {
      const probe = await this.group.openShard(probeRow.partitionKey)
      this.group.template.configure(probe)
      for (const leg of this.coPartitionedLegs) {
        if (!probe.resolveRef(this.collectionName, leg.field)) {
          throw new CrossShardJoinError(
            `crossShardJoin("${leg.field}"): no ref() declared for "${leg.field}" on ` +
              `collection "${this.collectionName}" in template "${this.group.sharding.vaultTemplate}". ` +
              `Add refs: { ${leg.field}: ref('<target>') } to the template's collection options.`,
          )
        }
      }
    }
    const across = await this.group.db.queryAcross<R[]>(
      eligible.map((r) => r.vaultId),
      async (vault) => {
        this.group.template.configure(vault)
        const coll = vault.collection<R>(this.collectionName)
        await coll.list() // hydrate the in-memory cache before the sync query
        // Hydrate each co-partitioned join target — resolveSource reads the
        // in-memory cache, so an unopened right collection would join to an
        // empty snapshot (every row → null).
        for (const leg of this.coPartitionedLegs) {
          const desc = vault.resolveRef(this.collectionName, leg.field)
          if (desc) await vault.collection(desc.target).list()
        }
        let q = coll.query()
        for (const c of this.clauses) q = q.where(c.field, c.op, c.value)
        for (const leg of this.coPartitionedLegs) {
          q = q.join(leg.field, {
            as: leg.as,
            ...(leg.maxRows !== undefined ? { maxRows: leg.maxRows } : {}),
            ...(leg.strategy ? { strategy: leg.strategy } : {}),
          })
        }
        return q.toArray()
      },
      { concurrency: options.concurrency ?? 1, create: false },
    )
    const results: R[] = []
    for (const r of across) {
      if (r.error) skipped.push({ vaultId: r.vault, reason: classifyShardSkip(r.error), error: r.error })
      else for (const item of r.result) results.push(item)
    }
    return { records: results, skippedVaults: skipped }
  }

  /** Fan out across eligible shards, merge, then apply any broadcast dimension legs. */
  async toArray(options: FanoutQueryOptions = {}): Promise<FanoutResult<R>> {
    const { records, skippedVaults } = await this.fanoutRecords(options)
    const results = (await applyBroadcastLegs(records, this.broadcastLegs)) as R[]
    return { results, skippedVaults }
  }

  /** @internal — build the change-subscription + relevance binding for this query's group+collection. */
  liveBinding(): LiveBinding {
    const group = this.group
    const collectionName = this.collectionName
    return {
      subscribeToChanges: (h) => { group.db.on('change', h); return () => group.db.off('change', h) },
      isRelevant: (e) => e.collection === collectionName && e.vault.startsWith(`${group.name}--`),
    }
  }

  /** @internal — joined queries don't support reactive/aggregate surfaces in v1. */
  private assertNoJoinLegs(surface: string): void {
    if (this.coPartitionedLegs.length || this.broadcastLegs.length) {
      throw new CrossShardJoinError(
        `${surface}() is not supported on a ShardedQuery with crossShardJoin/broadcastJoin ` +
          `legs in v1. Use toArray() for joined cross-shard queries.`,
      )
    }
  }

  /** Returns a reactive cross-shard live query — a facade over CrossVaultLive. */
  live(options: LiveQueryOptions = {}): CrossVaultLiveQuery<R> {
    this.assertNoJoinLegs('live')
    const bind = this.liveBinding()
    const core = new CrossVaultLive<{ records: R[]; skipped: SkippedVault[] }>({
      ...bind,
      compute: async () => {
        const { records, skippedVaults } = await this.fanoutRecords(options)
        return { records, skipped: skippedVaults }
      },
      initialSnapshot: { records: [], skipped: [] },
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    })
    return {
      get value() { return core.snapshot.records as readonly R[] },
      get skippedVaults() { return core.snapshot.skipped as readonly SkippedVault[] },
      get error() { return core.error },
      ready: core.ready,
      subscribe: (cb) => core.subscribe(cb),
      stop: () => core.stop(),
    }
  }

  /** One-shot distributed aggregate — central reduce over all shard records. */
  aggregate<Spec extends AggregateSpec>(spec: Spec): CrossVaultAggregation<R, Spec> {
    this.assertNoJoinLegs('aggregate')
    return new CrossVaultAggregation<R, Spec>(this, spec, this.liveBinding())
  }

  /** Begin a grouped cross-shard aggregate. */
  groupBy<F extends string>(field: F): ShardedGroupedQuery<T, R, F> {
    this.assertNoJoinLegs('groupBy')
    return new ShardedGroupedQuery<T, R, F>(this, field)
  }
}

/** Grouped cross-shard query — intermediate after `.groupBy(field)`, terminates with `.aggregate(spec)`. */
export class ShardedGroupedQuery<T, R, F extends string> {
  constructor(
    private readonly query: ShardedQuery<T, R>,
    private readonly field: F,
  ) {}

  aggregate<Spec extends AggregateSpec>(spec: Spec): CrossVaultGroupedAggregation<R, F, Spec> {
    return new CrossVaultGroupedAggregation<R, F, Spec>(
      { fanoutRecords: (o) => this.query.fanoutRecords(o) } satisfies FanoutRecordSource<R>,
      this.field,
      spec,
      this.query.liveBinding(),
    )
  }
}
