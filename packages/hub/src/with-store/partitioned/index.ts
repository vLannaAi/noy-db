/**
 * Partitioned collections — the union read path and the declaration surface
 * (#1342, ADR 0007 "partitioning is collection-shaped").
 *
 * ## What was ruled, and what that left to build
 *
 * ADR 0007 ruled **NO** on lifting a partition value into a storage key or
 * into cleartext envelope metadata: it is a permanent per-record
 * classification handed to the backend, and it widens `@noy-db/hub/to` across
 * every `to-*` adapter and the conformance kit to buy a win on one read path.
 * `NoydbStore.listPage` is untouched by this file, and must stay untouched.
 *
 * It ruled instead that **a partition IS a collection**. The store already
 * sees collection names in cleartext — `listPage(vault, collection, cursor,
 * limit)` takes the name as a parameter — so `invoices@FY2026-Q1` prunes for
 * free: `listPage` never fetches an excluded partition because it is never
 * asked to. No seam change, no new leak class, and partition = collection =
 * DEK makes it a REAL boundary rather than an advisory one (per-collection
 * wrapping, #1004): a principal granted only Q1 cannot decrypt Q2, and a
 * closed period's DEK can be archived or dropped outright — something a
 * scoped predicate can never do.
 *
 * The honest cost of that ruling was three missing pieces. This module is
 * them:
 *
 *   1. **a cross-collection union read path** — there was none, so a query
 *      spanning four quarters meant running four and merging by hand;
 *   2. **cheap partition enumeration** — `vault.collections()` is
 *      `adapter.loadAll(vault)`, the WHOLE vault snapshot, so even LISTING
 *      partitions cost a full load;
 *   3. **a declaration** binding a set of collections into one logical
 *      collection with a partition key, so a `where` on that key can prune.
 *
 * ## Where the win actually is
 *
 * `collection.query()` runs over an already-decrypted in-memory cache with
 * hash / sorted / compound dispatch in front of it (#1344, #1345), so pruning
 * there is strictly weaker than an index that already ships. `scan()` is the
 * prize: every page is DECRYPTED, so a partition never fetched is a page
 * never decrypted. {@link PartitionedScan} is where the measured win lives;
 * {@link PartitionedQuery} exists because a union that only streams is not a
 * union read path.
 *
 * ## Why this is a free function and not `vault.partitioned()`
 *
 * `check-architecture`'s kernel-surface ratchet leaves `vault.ts` one line of
 * headroom, and a service that re-couples itself into the kernel is exactly
 * what that ratchet exists to catch. It is also not a `with*()` factory: once
 * ADR 0007 removed the storage-layout policy (there is no key prefixing to
 * configure — the partition is a collection), nothing is left to opt into.
 * What remains is a query-shaped helper over collections the caller already
 * owns, so it is a plain function, tree-shaken when unused.
 *
 * ## The immutability precondition, stated once
 *
 * ⛔ **A record's partition key must be immutable.** If a record can be edited
 * from one partition to another, a scope derived at plan time and a scope
 * derived at read time can disagree, and the difference is silently missing
 * rows. {@link PartitionedCollection.put} routes on `record[key]` and will
 * happily write the same id into two partitions if the key changes; it does
 * not police this, because it cannot see the prior value without reading
 * every partition — which is the cost the whole design exists to avoid.
 */

import type { Collection } from '../../kernel/collection.js'
import type { Vault } from '../../kernel/vault.js'
import type { Clause, Operator } from '../../kernel/query/predicate.js'
import type { OrderBy, QueryPlan } from '../../kernel/query/builder.js'
import { sortRecords } from '../../kernel/query/builder.js'
import type { ExplainNode, QueryExplanation } from '../../kernel/query/explain.js'
import { renderExplainText } from '../../kernel/query/explain.js'
import { ScanBuilder } from '../../kernel/query/scan-builder.js'
import type { ScanPageProvider } from '../../kernel/query/scan-builder.js'
import type { ReduceResult, ReduceSpec } from '../../with-lookup/reduce/reduction.js'
import { reduceRecords } from '../../with-lookup/reduce/reduction.js'
import {
  ALL_PARTITIONS,
  describePartitionScope,
  partitionsInScope,
  resolvePartitionScope,
} from '../../kernel/query/partition.js'
import type { PartitionScope } from '../../kernel/query/partition.js'

/**
 * The collection holding one registry record per partitioned logical
 * collection. A normal, ENCRYPTED collection — the partition list is record
 * content, not a record id, so declaring a partition set adds no cleartext
 * channel of its own. (The partition VALUES do become collection names, and
 * that exposure is ADR 0007's deliberate, developer-visible trade; this
 * registry does not widen it.)
 */
export const PARTITION_REGISTRY_COLLECTION = '_partition_sets'

interface PartitionRegistryRecord {
  readonly id: string
  readonly partitions: readonly string[]
}

/** How a partition value becomes a collection name. */
export type PartitionNamer = (logicalName: string, partition: string) => string

/** The default: `invoices` + `FY2026-Q1` → `invoices@FY2026-Q1`. */
export const defaultPartitionNamer: PartitionNamer = (name, partition) => `${name}@${partition}`

export interface PartitionSpec<T> {
  /** The logical collection name. Never itself a stored collection. */
  readonly name: string
  /**
   * The field whose value names the partition. ⛔ Must be immutable per
   * record — see this module's header.
   */
  readonly key: keyof T & string
  /**
   * Partition values known to the caller. Merged with whatever the registry
   * already holds, so a caller may declare none and rely on the registry, or
   * declare the full set and never write one.
   */
  readonly partitions?: readonly string[]
  /** Override the partition → collection-name mapping. */
  readonly namer?: PartitionNamer
  /**
   * Options passed to every member `vault.collection()` — indexes, refs,
   * schema. Identical across partitions by construction: they are one logical
   * collection, and a per-partition shape would make the union unsound.
   */
  readonly collectionOptions?: unknown
}

/**
 * Bind a set of collections into one partitioned logical collection.
 *
 * ```ts
 * const invoices = partitioned<Invoice>(vault, {
 *   name: 'invoices',
 *   key: 'period',
 *   partitions: ['FY2026-Q1', 'FY2026-Q2', 'FY2026-Q3', 'FY2026-Q4'],
 * })
 *
 * await invoices.put('inv-1', { id: 'inv-1', period: 'FY2026-Q1', amount: 100 })
 *
 * // reads ONE collection — the other three are never asked for
 * const q1 = await invoices.query().where('period', '==', 'FY2026-Q1').all()
 *
 * // reads all four, merged, sorted and paged AFTER the union
 * const top = await invoices.query().orderBy('amount', 'desc').limit(10).all()
 * ```
 */
export function partitioned<T>(vault: Vault, spec: PartitionSpec<T>): PartitionedCollection<T> {
  return new PartitionedCollection<T>(vault, spec)
}

export class PartitionedCollection<T> {
  readonly name: string
  readonly key: string
  private readonly vault: Vault
  private readonly namer: PartitionNamer
  private readonly collectionOptions: unknown
  private readonly declared: string[]
  /**
   * Session cache of the REGISTRY's partition list — deliberately not of the
   * merged set. The two are different questions and conflating them cost a
   * red test: `ensurePartition` must persist a partition the caller DECLARED
   * but never wrote, and a cache of the merged set makes every declared value
   * look already-known, so the registry stays empty and a later session that
   * declares nothing enumerates nothing.
   */
  private stored: string[] | null = null

  constructor(vault: Vault, spec: PartitionSpec<T>) {
    this.vault = vault
    this.name = spec.name
    this.key = spec.key
    this.namer = spec.namer ?? defaultPartitionNamer
    this.collectionOptions = spec.collectionOptions
    this.declared = [...(spec.partitions ?? [])]
  }

  /** The member collection name for a partition value. */
  collectionNameOf(partition: string): string {
    return this.namer(this.name, partition)
  }

  /** The member `Collection` for one partition. */
  partition(value: string): Collection<T> {
    return this.vault.collection<T>(
      this.collectionNameOf(value),
      this.collectionOptions as never,
    ) as unknown as Collection<T>
  }

  /**
   * The declared partition set, in declaration order.
   *
   * ⭐ **This is the "cheap enumeration" half of #1342, and cheap means a
   * measured thing.** `vault.collections()` is `adapter.loadAll(vault)` — the
   * whole vault snapshot, every collection, every envelope — so enumerating
   * twelve quarters cost a full load before this existed. Here it is ONE
   * record read out of {@link PARTITION_REGISTRY_COLLECTION}, and zero reads
   * once the session has resolved it.
   * `__tests__/partitioned-collection.test.ts` asserts the `loadAll` count is
   * zero rather than trusting the sentence.
   */
  async partitions(): Promise<readonly string[]> {
    const stored = await this.loadStored()
    const merged = [...this.declared]
    for (const p of stored) if (!merged.includes(p)) merged.push(p)
    return merged
  }

  /**
   * Declare a partition, persisting it so a later session enumerates it
   * without the caller re-declaring. Idempotent, and keyed on what the
   * REGISTRY holds rather than on what this handle declared.
   */
  async ensurePartition(value: string): Promise<void> {
    const stored = await this.loadStored()
    if (stored.includes(value)) return
    stored.push(value)
    await this.registry().put(this.name, { id: this.name, partitions: [...stored] })
  }

  private async loadStored(): Promise<string[]> {
    if (this.stored === null) {
      this.stored = [...((await this.registry().get(this.name))?.partitions ?? [])]
    }
    return this.stored
  }

  /**
   * Write a record into the partition its key names, declaring that partition
   * if it is new.
   *
   * Throws when `record[key]` is not a string — a partition value names a
   * collection, and routing a record to a partition derived by coercion is
   * how a record ends up somewhere no query will look for it.
   */
  async put(id: string, record: T): Promise<void> {
    const value = (record as Record<string, unknown>)[this.key]
    if (typeof value !== 'string' || value === '') {
      throw new PartitionKeyError(this.name, this.key, value)
    }
    await this.ensurePartition(value)
    await this.partition(value).put(id, record as never)
  }

  /** A union query across the member collections, pruned by the predicate. */
  query(): PartitionedQuery<T> {
    return new PartitionedQuery<T>(this, [], [], undefined, 0)
  }

  /**
   * A union scan across the member collections, pruned by the predicate.
   * Pages are decrypted, so an excluded partition is decryption never paid.
   */
  scan(opts: { pageSize?: number } = {}): PartitionedScan<T> {
    return new PartitionedScan<T>(this, [], opts.pageSize ?? 100)
  }

  /** @internal — the normalizer for clause shapes, and the union's legs. */
  _registryName(): string {
    return PARTITION_REGISTRY_COLLECTION
  }

  private registry(): Collection<PartitionRegistryRecord> {
    return this.vault.collection<PartitionRegistryRecord>(
      PARTITION_REGISTRY_COLLECTION,
    ) as unknown as Collection<PartitionRegistryRecord>
  }
}

/** `record[partitionKey]` was absent, empty, or not a string. */
export class PartitionKeyError extends Error {
  constructor(collection: string, key: string, value: unknown) {
    super(
      `[noy-db] partitioned("${collection}"): record.${key} must be a non-empty string ` +
      `naming its partition, got ${typeof value === 'string' ? '""' : String(value)}. ` +
      `A partition value names a collection; it is never coerced.`,
    )
    this.name = 'PartitionKeyError'
  }
}

/**
 * One recorded builder call, replayed onto each in-scope member's own
 * builder.
 *
 * ⭐ **Replay, not re-implementation.** The alternative was to build `Clause`
 * objects here, which would have meant a second copy of `Query.where()`'s
 * normalization — the `matches` lowering (#1357), the subquery resolution
 * (#1351), the Via posture gate and the operand rewrite. A second copy is a
 * second thing to drift. Instead every leg is a real `Query` / `ScanBuilder`
 * that normalized the call itself, and the PRUNING reads the normalized
 * `Clause[]` back off one of them — so the clause the pruner classifies is
 * byte-identical to the clause the executor evaluates.
 */
type Step<T> =
  | { readonly kind: 'where'; readonly field: string; readonly op: Operator; readonly value: unknown }
  | { readonly kind: 'filter'; readonly fn: (record: T) => boolean }

interface LegBuilder<B> {
  where(field: never, op: Operator, value: unknown): B
  filter(fn: never): B
}

function replay<T, B extends LegBuilder<B>>(builder: B, steps: readonly Step<T>[]): B {
  let out = builder
  for (const step of steps) {
    out = step.kind === 'where'
      ? out.where(step.field as never, step.op, step.value)
      : out.filter(step.fn as never)
  }
  return out
}

/**
 * The clauses a scope decision is taken over: the NORMALIZED top-level clause
 * list, obtained by replaying the recorded steps onto a real member query.
 *
 * When the partition set is empty there is no member to normalize against —
 * and no partition to prune to either, so the scope is empty regardless.
 */
function normalizedClauses<T>(
  col: PartitionedCollection<T>,
  declared: readonly string[],
  steps: readonly Step<T>[],
): readonly Clause[] {
  if (declared.length === 0) return []
  const probe = replay(col.partition(declared[0]!).query() as never, steps) as unknown as {
    _plan(): QueryPlan
  }
  return probe._plan().clauses
}

/**
 * A union query across a partitioned collection's members.
 *
 * **Filtering runs per leg; ordering and paging run AFTER the union** — the
 * same shape `orderBy('client.name')` needed when the sort moved after the
 * join legs (#1337). A `limit` is deliberately NOT pushed down: the top ten
 * of the union is not the top ten of any one leg, and a leg-local limit would
 * be correct only for an unordered query, which is the case nobody writes.
 */
export class PartitionedQuery<T> {
  constructor(
    private readonly col: PartitionedCollection<T>,
    private readonly steps: readonly Step<T>[],
    private readonly orderBys: readonly OrderBy[],
    private readonly limitN: number | undefined,
    private readonly offsetN: number,
  ) {}

  private with(
    patch: Partial<{
      steps: readonly Step<T>[]
      orderBys: readonly OrderBy[]
      limitN: number | undefined
      offsetN: number
    }>,
  ): PartitionedQuery<T> {
    return new PartitionedQuery<T>(
      this.col,
      patch.steps ?? this.steps,
      patch.orderBys ?? this.orderBys,
      'limitN' in patch ? patch.limitN : this.limitN,
      patch.offsetN ?? this.offsetN,
    )
  }

  where(field: keyof T & string, op: Operator, value: unknown): PartitionedQuery<T> {
    return this.with({ steps: [...this.steps, { kind: 'where', field, op, value }] })
  }

  filter(fn: (record: T) => boolean): PartitionedQuery<T> {
    return this.with({ steps: [...this.steps, { kind: 'filter', fn }] })
  }

  orderBy(field: keyof T & string, direction: 'asc' | 'desc' = 'asc'): PartitionedQuery<T> {
    return this.with({ orderBys: [...this.orderBys, { field, direction }] })
  }

  limit(n: number): PartitionedQuery<T> {
    return this.with({ limitN: n })
  }

  offset(n: number): PartitionedQuery<T> {
    return this.with({ offsetN: n })
  }

  /** The pruning decision for this query, and the set it was taken against. */
  async scope(): Promise<{ declared: readonly string[]; scope: PartitionScope }> {
    const declared = await this.col.partitions()
    const clauses = normalizedClauses(this.col, declared, this.steps)
    return { declared, scope: resolvePartitionScope(clauses, this.col.key, declared) }
  }

  /**
   * The matched rows, unordered and unpaged — the set every reduce-shaped
   * terminal reports over, matching `Query.count()`'s rule that orderBy /
   * limit / offset describe a page and a reduction is not paginated.
   */
  private async matched(): Promise<T[]> {
    const { declared, scope } = await this.scope()
    const rows: T[] = []
    for (const p of partitionsInScope(scope, declared)) {
      const leg = replay(this.col.partition(p).query() as never, this.steps) as unknown as {
        toArray(): T[]
      }
      rows.push(...leg.toArray())
    }
    return rows
  }

  /** The union, sorted then paged. */
  async all(): Promise<T[]> {
    let rows = await this.matched()
    if (this.orderBys.length > 0) rows = sortRecords(rows, this.orderBys) as T[]
    if (this.offsetN > 0) rows = rows.slice(this.offsetN)
    if (this.limitN !== undefined) rows = rows.slice(0, this.limitN)
    return rows
  }

  async first(): Promise<T | null> {
    return (await this.all())[0] ?? null
  }

  async count(): Promise<number> {
    return (await this.matched()).length
  }

  async aggregate<Spec extends ReduceSpec>(spec: Spec): Promise<ReduceResult<Spec>> {
    return reduceRecords(await this.matched(), spec)
  }

  /**
   * The plan, with the partition decision as its first line:
   *
   * ```
   * partitions partitions: 1 of 12 scanned [partitions:pruned] -- key "period"; FY2026-Q1
   * source snapshot (no indexes) [source] rows=500
   * where period == "FY2026-Q1" [scan] rows=500
   * ```
   *
   * ⭐ The dispatch label is decided by {@link resolvePartitionScope} — the
   * SAME call the executor makes, not a mirror of it. `explain.ts`'s header
   * warns that its index dispatch mirrors `candidateRecords`; #1375 deleted
   * one such mirror, and a partition dispatch would have been a third site.
   *
   * The nodes after the partition line are the FIRST in-scope member's own
   * explanation. Every member runs the same plan over the same shape, so one
   * leg's nodes describe them all; the partition line is what says how many
   * legs there are.
   */
  async explain(): Promise<QueryExplanation> {
    const { declared, scope } = await this.scope()
    const inScope = partitionsInScope(scope, declared)
    const pruned = scope !== ALL_PARTITIONS && inScope.length < declared.length
    const notes = [`key "${this.col.key}"`]
    notes.push(
      inScope.length === 0
        ? 'no partition admits this predicate — nothing is read'
        : inScope.join(', '),
    )
    if (!pruned && declared.length > 0) {
      notes.push('predicate proves no narrowing — every partition is read')
    }
    const head: ExplainNode = {
      op: 'partitions',
      dispatch: pruned ? 'partitions:pruned' : 'partitions:all',
      detail: describePartitionScope(scope, declared),
      estimatedRows: undefined,
      notes,
      children: [],
    }
    const legNodes: readonly ExplainNode[] = inScope.length === 0
      ? []
      : (replay(this.col.partition(inScope[0]!).query() as never, this.steps) as unknown as {
          explain(): QueryExplanation
        }).explain().nodes
    const nodes = [head, ...legNodes]
    return { nodes, caps: [], reducerRewrite: [], text: renderExplainText(nodes) }
  }
}

/**
 * A union scan across a partitioned collection's members — **the path where
 * pruning pays.**
 *
 * Each page is fetched through the member collection's `listPage`, which
 * DECRYPTS it. An excluded partition is therefore not merely a store call
 * skipped, it is every envelope in that partition never decrypted. That is
 * the whole return on ADR 0007, and `__tests__/partitioned-scan-cost.test.ts`
 * measures it rather than asserting it.
 *
 * The builder records `where`/`filter` and only materializes a
 * {@link ScanBuilder} at the terminal, because the partition set cannot be
 * decided before the predicate is known — a provider fixed at `scan()` time
 * would already have committed to every partition.
 */
export class PartitionedScan<T> {
  constructor(
    private readonly col: PartitionedCollection<T>,
    private readonly steps: readonly Step<T>[],
    private readonly pageSize: number,
  ) {}

  where(field: keyof T & string, op: Operator, value: unknown): PartitionedScan<T> {
    return new PartitionedScan<T>(
      this.col,
      [...this.steps, { kind: 'where', field, op, value }],
      this.pageSize,
    )
  }

  filter(fn: (record: T) => boolean): PartitionedScan<T> {
    return new PartitionedScan<T>(this.col, [...this.steps, { kind: 'filter', fn }], this.pageSize)
  }

  /** The pruning decision for this scan, and the set it was taken against. */
  async scope(): Promise<{ declared: readonly string[]; scope: PartitionScope }> {
    const declared = await this.col.partitions()
    const clauses = normalizedClauses(this.col, declared, this.steps)
    return { declared, scope: resolvePartitionScope(clauses, this.col.key, declared) }
  }

  /**
   * The union as a single {@link ScanBuilder} — so `.aggregate()`,
   * `.groupBy()` and `for await` come from the streaming machinery that
   * already exists, at its existing O(reducers) memory bound, rather than
   * from a second implementation of it.
   */
  async builder(): Promise<ScanBuilder<T>> {
    const { declared, scope } = await this.scope()
    const members = partitionsInScope(scope, declared).map((p) => this.col.partition(p))
    return replay(
      new ScanBuilder<T>(unionPageProvider(members), this.pageSize) as never,
      this.steps,
    ) as unknown as ScanBuilder<T>
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    yield* await this.builder()
  }

  async aggregate<Spec extends ReduceSpec>(spec: Spec): Promise<ReduceResult<Spec>> {
    return (await this.builder()).aggregate(spec)
  }

  async toArray(): Promise<T[]> {
    const out: T[] = []
    for await (const record of this) out.push(record)
    return out
  }
}

/**
 * Walk a list of member collections as ONE paged stream.
 *
 * The composite cursor is `"<memberIndex>|<memberCursor>"`. Two properties
 * make it safe to hand back to a consumer that stores it:
 *
 *   - it is opaque in exactly the way a store's own cursor is — the member
 *     cursor is passed through verbatim and never parsed;
 *   - a member's LAST page returns a cursor pointing at the NEXT member with
 *     an empty inner cursor, so exhaustion is detected once, not per page.
 *
 * ⚠️ A member that returns an empty page with a non-null cursor is walked
 * again rather than treated as exhausted — the store contract explicitly
 * allows a store to return fewer items than the limit while more exist.
 */
export function unionPageProvider<T>(members: readonly Collection<T>[]): ScanPageProvider<T> {
  return {
    async listPage(opts: { cursor?: string; limit?: number }) {
      let index = 0
      let inner: string | undefined
      if (opts.cursor !== undefined) {
        const at = opts.cursor.indexOf('|')
        index = Number.parseInt(opts.cursor.slice(0, at), 10)
        const rest = opts.cursor.slice(at + 1)
        inner = rest === '' ? undefined : rest
      }
      while (index < members.length) {
        const page = await (members[index]! as unknown as {
          listPage(o: { cursor?: string; limit?: number }): Promise<{ items: T[]; nextCursor: string | null }>
        }).listPage({ ...(inner !== undefined ? { cursor: inner } : {}), ...(opts.limit !== undefined ? { limit: opts.limit } : {}) })
        if (page.nextCursor !== null) {
          return { items: page.items, nextCursor: `${index}|${page.nextCursor}` }
        }
        index += 1
        inner = undefined
        if (page.items.length > 0) {
          return { items: page.items, nextCursor: index < members.length ? `${index}|` : null }
        }
      }
      return { items: [], nextCursor: null }
    },
  }
}
