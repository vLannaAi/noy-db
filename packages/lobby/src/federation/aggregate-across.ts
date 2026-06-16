/**
 * @category capability
 * One-shot distributed aggregate wrappers for cross-vault fan-out.
 * Central-reduce: all shard records are concatenated and reduced in one pass
 * so avg/mean values are computed over the full union, not as avg-of-avgs.
 * Spec: docs/superpowers/specs/2026-06-07-cross-vault-live-and-aggregate-design.md.
 */
import { reduceRecords } from '@noy-db/hub/kernel'
import { groupAndReduce } from '@noy-db/hub/kernel'
import type { AggregateResult, AggregateSpec } from '@noy-db/hub/kernel'
import type {
  FanoutQueryOptions,
  SkippedVault,
  GroupedRow,
  LiveQueryOptions,
  CrossVaultLiveAggregation,
  CrossVaultLiveQuery,
} from './types.js'
import { CrossVaultLive } from './cross-vault-live.js'
import type { ChangeEvent } from '@noy-db/hub/kernel'

/** A source that can fan out records across shards. Satisfied by ShardedQuery. */
export interface FanoutRecordSource<R> {
  fanoutRecords(options: FanoutQueryOptions): Promise<{ records: R[]; skippedVaults: SkippedVault[] }>
}

/** Live-binding hooks (change subscription + relevance) threaded from ShardedQuery. */
export interface LiveBinding {
  subscribeToChanges: (handler: (e: ChangeEvent) => void) => () => void
  isRelevant: (e: ChangeEvent) => boolean
}

/**
 * One-shot cross-vault aggregate. Concatenates all shard records and runs a
 * single central reduce, ensuring correct avg/mean values.
 */
export class CrossVaultAggregation<R, Spec extends AggregateSpec> {
  constructor(
    private readonly src: FanoutRecordSource<R>,
    private readonly spec: Spec,
    private readonly bind?: LiveBinding,
  ) {}

  async run(options: FanoutQueryOptions = {}): Promise<{
    result: AggregateResult<Spec>
    skippedVaults: SkippedVault[]
  }> {
    const { records, skippedVaults } = await this.src.fanoutRecords(options)
    return { result: reduceRecords(records, this.spec), skippedVaults }
  }

  live(options: LiveQueryOptions = {}): CrossVaultLiveAggregation<AggregateResult<Spec>> {
    if (!this.bind) throw new Error('CrossVaultAggregation: live() requires a LiveBinding — use ShardedQuery.aggregate()')
    const spec = this.spec
    const src = this.src
    const core = new CrossVaultLive<{ value: AggregateResult<Spec> | undefined; skipped: SkippedVault[] }>({
      subscribeToChanges: this.bind.subscribeToChanges,
      isRelevant: this.bind.isRelevant,
      compute: async () => {
        const { records, skippedVaults } = await src.fanoutRecords(options)
        return { value: reduceRecords(records, spec), skipped: skippedVaults }
      },
      initialSnapshot: { value: undefined, skipped: [] },
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    })
    return {
      get value() { return core.snapshot.value },
      get skippedVaults() { return core.snapshot.skipped as readonly SkippedVault[] },
      get error() { return core.error },
      ready: core.ready,
      subscribe: (cb) => core.subscribe(cb),
      stop: () => core.stop(),
    }
  }
}

/**
 * One-shot cross-vault grouped aggregate. Concatenates all shard records and
 * runs a single central group-and-reduce, emitting one row per bucket.
 */
export class CrossVaultGroupedAggregation<R, F extends string, Spec extends AggregateSpec> {
  constructor(
    private readonly src: FanoutRecordSource<R>,
    private readonly field: F,
    private readonly spec: Spec,
    private readonly bind?: LiveBinding,
  ) {}

  async run(options: FanoutQueryOptions = {}): Promise<{
    results: GroupedRow<F, Spec>[]
    skippedVaults: SkippedVault[]
  }> {
    const { records, skippedVaults } = await this.src.fanoutRecords(options)
    return {
      results: groupAndReduce<GroupedRow<F, Spec>>(records, this.field, this.spec),
      skippedVaults,
    }
  }

  live(options: LiveQueryOptions = {}): CrossVaultLiveQuery<GroupedRow<F, Spec>> {
    if (!this.bind) throw new Error('CrossVaultGroupedAggregation: live() requires a LiveBinding — use ShardedQuery.groupBy().aggregate()')
    const field = this.field
    const spec = this.spec
    const src = this.src
    const core = new CrossVaultLive<{ records: GroupedRow<F, Spec>[]; skipped: SkippedVault[] }>({
      subscribeToChanges: this.bind.subscribeToChanges,
      isRelevant: this.bind.isRelevant,
      compute: async () => {
        const { records, skippedVaults } = await src.fanoutRecords(options)
        return {
          records: groupAndReduce<GroupedRow<F, Spec>>(records, field, spec),
          skipped: skippedVaults,
        }
      },
      initialSnapshot: { records: [], skipped: [] },
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    })
    return {
      get value() { return core.snapshot.records as readonly GroupedRow<F, Spec>[] },
      get skippedVaults() { return core.snapshot.skipped as readonly SkippedVault[] },
      get error() { return core.error },
      ready: core.ready,
      subscribe: (cb) => core.subscribe(cb),
      stop: () => core.stop(),
    }
  }
}
