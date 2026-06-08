/**
 * @category capability
 * Multi-vault partition federation — VaultGroup transparent shard
 * routing. Spec:
 * docs/superpowers/specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md.
 */
import type { Noydb } from '../noydb.js'
import type { Vault } from '../vault.js'
import type { Collection } from '../collection.js'
import { ShardProvisioningError, UnknownShardError, ValidationError } from '../errors.js'
import { classifyShardSkip } from './classify-skip.js'
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
} from './types.js'

/** Reserved separator between group name and partition key in a shard vault id. */
const SHARD_SEPARATOR = '--'
/** Store-safe partition-key charset (single hyphens OK; '--' is the reserved separator). */
const SAFE_PARTITION_KEY = /^[A-Za-z0-9._-]+$/

function assertSafePartitionKey(partitionKey: string): void {
  if (partitionKey.length === 0) {
    throw new ValidationError('partitionKey must be a non-empty string')
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
  ) {
    if (name.includes(SHARD_SEPARATOR)) {
      throw new ValidationError(
        `VaultGroup name "${name}" must not contain "--" (reserved shard vault-id separator).`,
      )
    }
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

  /** All registry rows (hydrates the registry collection first). */
  async allRows(): Promise<VaultRegistryRow[]> {
    await this.registry.list()
    return this.registry.query().toArray()
  }

  /** Open an existing shard and apply the template. */
  async openShard(partitionKey: string): Promise<Vault> {
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
  ) {}

  where(field: string, op: WhereClause['op'], value: unknown): ShardedQuery<T, R> {
    return new ShardedQuery<T, R>(this.group, this.collectionName, [
      ...this.clauses,
      { field, op, value },
    ])
  }

  /** @internal — fan out the where-filtered records across eligible shards. */
  async fanoutRecords(options: FanoutQueryOptions = {}): Promise<{ records: R[]; skippedVaults: SkippedVault[] }> {
    const { eligible, skipped } = await this.group.resolveEligible(options)
    const across = await this.group.db.queryAcross<R[]>(
      eligible.map((r) => r.vaultId),
      async (vault) => {
        this.group.template.configure(vault)
        const coll = vault.collection<R>(this.collectionName)
        await coll.list() // hydrate the in-memory cache before the sync query
        let q = coll.query()
        for (const c of this.clauses) q = q.where(c.field, c.op, c.value)
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

  /** Fan out across eligible shards and merge results. */
  async toArray(options: FanoutQueryOptions = {}): Promise<FanoutResult<R>> {
    const { records, skippedVaults } = await this.fanoutRecords(options)
    return { results: records, skippedVaults }
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

  /** Returns a reactive cross-shard live query — a facade over CrossVaultLive. */
  live(options: LiveQueryOptions = {}): CrossVaultLiveQuery<R> {
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
    return new CrossVaultAggregation<R, Spec>(this, spec, this.liveBinding())
  }

  /** Begin a grouped cross-shard aggregate. */
  groupBy<F extends string>(field: F): ShardedGroupedQuery<T, R, F> {
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
