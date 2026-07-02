/**
 * Vault-side refs / managed-links enforcement facade.
 *
 * Holds the foreign-key enforcement entry points the collection write path
 * reaches through the `refEnforcer` facade closure (`enforceRefsOnPut` /
 * `enforceRefsOnDelete`), the managed-link `onDelete` policy
 * (`enforceLinksOnDelete`), the `joinResolver` half (`resolveRef` /
 * `resolveSource`), the `checkIntegrity()` reporter, and the cascade-cycle
 * breaker set (`cascadeInProgress`). The ref/link registries stay
 * vault-resident (they are populated by `vault.collection()` / `vault.link()`
 * and read by the backup path) and arrive by reference through
 * {@link VaultLinksDeps}; every other `Vault` dependency arrives via the deps
 * interface.
 *
 * Internal service — reached through `vault.enforceRefsOnPut(...)` etc.
 */
import { RefIntegrityError, isRefArray, type RefDescriptor, type RefViolation, type RefRegistry } from '../../kernel/refs.js'
import {
  linkCollectionName,
  linkRowKey,
  LinkIntegrityError,
  type LinkSet,
  type LinkSpec,
  type LinkSetHandle,
} from './link-set.js'
import type { JoinableSource } from '../../kernel/query/index.js'
import type { Collection } from '../../kernel/collection.js'
import type { NoydbStore } from '../../kernel/types.js'
import type { TxContext } from '../../with-commit/tx/transaction.js'

/** Everything the moving refs/links methods touched on the vault's `this.*`. */
export interface VaultLinksDeps {
  /** Per-vault foreign-key registry (vault-resident; read by reference). */
  readonly refRegistry: RefRegistry
  /** Registered link specs, keyed by link name (vault-resident; read by reference). */
  readonly linkRegistry: ReadonlyMap<string, LinkSpec>
  /** The ciphertext store. */
  readonly adapter: NoydbStore
  /** Vault namespace name. */
  readonly vault: string
  /** Collection accessor (bound `vault.collection`). */
  collection<T = unknown>(name: string): Collection<T>
  /** Declared link-set accessor (bound `vault.links`). */
  links(name: string): LinkSetHandle
  /** Cache lookup for an already-opened collection (used by `resolveSource`). */
  getCachedCollection(name: string): Collection<unknown> | undefined
  /** The active transaction context, or null outside a tx. */
  getActiveTxContext(): TxContext | null
}

export class VaultLinks {
  /**
   * Set of collection record-ids currently being deleted as part of a cascade.
   * Populated on entry to `enforceRefsOnDelete` and drained on exit. Used to
   * break mutual-cascade cycles: deleting A → cascade to B → cascade back to A
   * would otherwise recurse forever, so we short-circuit when we see an
   * already-in-progress delete on the same (collection, id) pair.
   */
  private readonly cascadeInProgress = new Set<string>()

  constructor(private readonly deps: VaultLinksDeps) {}

  /**
   * Enforce strict outbound refs on a `put()`. Called by Collection
   * just before it writes to the adapter. For every strict ref
   * declared on the collection, check that the target id exists in
   * the target collection; throw `RefIntegrityError` if not.
   *
   * `warn` and `cascade` modes don't affect put semantics — they're
   * enforced at delete time or via `checkIntegrity()`.
   */
  async enforceRefsOnPut(collectionName: string, record: unknown): Promise<void> {
    const outbound = this.deps.refRegistry.getOutbound(collectionName)
    if (Object.keys(outbound).length === 0) return
    if (!record || typeof record !== 'object') return
    const obj = record as Record<string, unknown>

    for (const [field, descriptor] of Object.entries(outbound)) {
      if (descriptor.mode !== 'strict') continue
      const rawId = obj[field]
      // Nullish ref values are allowed — treat them as "no reference".
      // Users who want "always required" should express it in their
      // Standard Schema validator via a non-optional field.
      if (rawId === null || rawId === undefined) continue

      // Array ref: validate each element against the target.
      if (isRefArray(descriptor)) {
        if (!Array.isArray(rawId)) {
          throw new RefIntegrityError({
            collection: collectionName,
            id: (obj['id'] as string | undefined) ?? '<unknown>',
            field,
            refTo: descriptor.target,
            refId: null,
            message: `Array ref field "${collectionName}.${field}" must be an array, got ${typeof rawId}.`,
          })
        }
        const arrTarget = this.deps.collection<Record<string, unknown>>(descriptor.target)
        for (const el of rawId) {
          if (typeof el !== 'string' && typeof el !== 'number') {
            throw new RefIntegrityError({
              collection: collectionName,
              id: (obj['id'] as string | undefined) ?? '<unknown>',
              field,
              refTo: descriptor.target,
              refId: null,
              message: `Array ref "${collectionName}.${field}" elements must be strings or numbers, got ${typeof el}.`,
            })
          }
          const elId = String(el)
          if (!(await arrTarget.get(elId))) {
            throw new RefIntegrityError({
              collection: collectionName,
              id: (obj['id'] as string | undefined) ?? '<unknown>',
              field,
              refTo: descriptor.target,
              refId: elId,
              message:
                `Strict array ref "${collectionName}.${field}" → "${descriptor.target}" ` +
                `cannot be satisfied: element id "${elId}" not found in "${descriptor.target}".`,
            })
          }
        }
        continue
      }

      // Refs must be strings or numbers — anything else (object,
      // array, boolean) is a programming error and should fail
      // loudly rather than serialize as "[object Object]".
      if (typeof rawId !== 'string' && typeof rawId !== 'number') {
        throw new RefIntegrityError({
          collection: collectionName,
          id: (obj['id'] as string | undefined) ?? '<unknown>',
          field,
          refTo: descriptor.target,
          refId: null,
          message:
            `Ref field "${collectionName}.${field}" must be a string or number, got ${typeof rawId}.`,
        })
      }
      const refId = String(rawId)
      const target = this.deps.collection<Record<string, unknown>>(descriptor.target)
      const exists = await target.get(refId)
      if (!exists) {
        throw new RefIntegrityError({
          collection: collectionName,
          id: (obj['id'] as string | undefined) ?? '<unknown>',
          field,
          refTo: descriptor.target,
          refId,
          message:
            `Strict ref "${collectionName}.${field}" → "${descriptor.target}" ` +
            `cannot be satisfied: target id "${refId}" not found in "${descriptor.target}".`,
        })
      }
    }
  }

  /**
   * Enforce inbound ref modes on a `delete()`. Called by Collection
   * just before it deletes from the adapter. Walks every inbound
   * ref that targets this (collection, id) and:
   *
   *   - `strict`: throws if any referencing records exist
   *   - `cascade`: deletes every referencing record
   *   - `warn`:    no-op (checkIntegrity picks it up)
   *
   * Cascade cycles are broken via `cascadeInProgress` — re-entering
   * for the same (collection, id) returns immediately so two
   * mutually-cascading collections don't recurse forever.
   */
  async enforceRefsOnDelete(collectionName: string, id: string): Promise<void> {
    const key = `${collectionName}/${id}`
    if (this.cascadeInProgress.has(key)) return
    this.cascadeInProgress.add(key)

    try {
      const inbound = this.deps.refRegistry.getInbound(collectionName)
      for (const rule of inbound) {
        const fromCollection = this.deps.collection<Record<string, unknown>>(rule.collection)
        // Scan the referencing collection for records whose ref
        // field matches this id. For eager-mode collections this
        // is an in-memory filter; for lazy-mode it requires a scan.
        const allRecords = await fromCollection.list()
        const matches = allRecords.filter((rec) => {
          const raw = rec[rule.field]
          // Array ref: match when any element equals the deleted id.
          if (rule.isArray) {
            return Array.isArray(raw) && raw.some(
              (el) => (typeof el === 'string' || typeof el === 'number') && String(el) === id,
            )
          }
          // Scalar: same string/number-only restriction as enforceRefsOnPut.
          // Anything else can't have been a valid ref to begin with,
          // so it can't match.
          if (typeof raw !== 'string' && typeof raw !== 'number') return false
          return String(raw) === id
        })
        if (matches.length === 0) continue

        if (rule.mode === 'strict') {
          const first = matches[0]
          throw new RefIntegrityError({
            collection: rule.collection,
            id: (first?.['id'] as string | undefined) ?? '<unknown>',
            field: rule.field,
            refTo: collectionName,
            refId: id,
            message:
              `Cannot delete "${collectionName}"/"${id}": ` +
              `${matches.length} record(s) in "${rule.collection}" still reference it via strict ref "${rule.field}".`,
          })
        }
        if (rule.mode === 'cascade') {
          // Atomicity: if a transaction is active, register each
          // child's prior envelope on it BEFORE the delete so a later
          // mid-batch failure rolls the cascade back alongside the
          // parent. Mirrors how derivation outputs self-register on the
          // active ctx. Outside a tx the context is null and we skip it.
          const txCtx = this.deps.getActiveTxContext()
          for (const match of matches) {
            const matchId = (match['id'] as string | undefined) ?? null
            if (matchId === null) continue
            if (txCtx !== null) {
              const prior = await this.deps.adapter.get(this.deps.vault, rule.collection, matchId)
              if (prior !== null) {
                txCtx._executed.push({
                  op: {
                    type: 'delete',
                    vaultName: this.deps.vault,
                    collectionName: rule.collection,
                    id: matchId,
                  },
                  priorEnvelope: prior,
                })
              }
            }
            // Recursive delete — the cycle breaker above catches
            // infinite loops.
            await fromCollection.delete(matchId)
          }
        }
        // warn: no-op
      }
      // Managed link sets: apply each link's onDelete to its rows
      // touching the deleted endpoint. Runs inside the same cascade guard /
      // before the adapter delete, so a 'strict' link blocks the delete.
      await this.enforceLinksOnDelete(collectionName, id)
    } finally {
      this.cascadeInProgress.delete(key)
    }
  }

  /**
   * @internal — apply link `onDelete` policy when an endpoint record is
   * deleted. `'strict'` throws (blocks the delete), `'cascade'`
   * removes the touching link rows (tx-atomic when a transaction is active),
   * `'warn'` leaves orphans for `checkIntegrity()`.
   */
  private async enforceLinksOnDelete(collectionName: string, id: string): Promise<void> {
    for (const [name, spec] of this.deps.linkRegistry) {
      if (spec.a !== collectionName && spec.b !== collectionName) continue
      const handle = this.deps.links(name) as LinkSet
      const touching = await handle._rowsTouchingEndpoint(collectionName, id)
      if (touching.length === 0) continue
      const mode = spec.onDelete ?? 'cascade'
      if (mode === 'warn') continue
      if (mode === 'strict') {
        throw new LinkIntegrityError(name, collectionName, id, touching.length)
      }
      // cascade — remove every touching link row.
      const linkColl = handle._collectionName
      const txCtx = this.deps.getActiveTxContext()
      for (const row of touching) {
        const rowKey = linkRowKey(row.a, row.b)
        if (txCtx !== null) {
          const prior = await this.deps.adapter.get(this.deps.vault, linkColl, rowKey)
          if (prior !== null) {
            txCtx._executed.push({
              op: { type: 'delete', vaultName: this.deps.vault, collectionName: linkColl, id: rowKey },
              priorEnvelope: prior,
            })
          }
        }
        await handle.disconnect(row.a, row.b)
      }
    }
  }

  /**
   * Look up the `RefDescriptor` the left collection declared for a
   * given field name. Returns `null` when the field has no ref
   * declaration — the Query builder turns that into an actionable
   * error at plan time (before any records are touched).
   *
   * Implements the `joinResolver.resolveRef` half of the structural
   * interface that `Collection.query()` consumes. See
   * `query/join.ts` for the full design.
   */
  resolveRef(leftCollection: string, field: string): RefDescriptor | null {
    const outbound = this.deps.refRegistry.getOutbound(leftCollection)
    return outbound[field] ?? null
  }

  /**
   * Resolve a right-side join source by target collection name.
   * Returns `null` for unknown collections so the Query executor can
   * surface an actionable error naming the missing target.
   *
   * Implements the `joinResolver.resolveSource` half of the
   * structural interface. The returned JoinableSource is a thin
   * wrapper that reads the target collection's in-memory cache via
   * `list()` / `get()` synchronously — the cache is populated by an
   * earlier `ensureHydrated()` call through the target's query/list
   * path. If the target has not been opened yet in this session the
   * join will see an empty snapshot; consumers who hit this can
   * open the target collection explicitly before running the query.
   *
   * Only same-vault targets are resolvable — cross-vault
   * joins are explicitly forbidden by the architecture`).
   */
  resolveSource(collectionName: string): JoinableSource | null {
    // Reject internal / reserved collection names — joins against
    // `_ledger/`, `_keyring/`, `_deltas/`, etc. are never legitimate.
    if (collectionName.startsWith('_')) return null
    const coll = this.deps.getCachedCollection(collectionName)
    if (!coll) return null
    // Collection exposes a structural `querySourceForJoin()` method
    // that returns a lightweight snapshot/lookupById view backed by
    // its in-memory cache. Typed as unknown here because
    // Collection<T> is covariant on T — the join executor only
    // reads fields by name and doesn't care about the concrete type.
    return (coll as unknown as {
      querySourceForJoin(): JoinableSource
    }).querySourceForJoin()
  }

  /**
   * Walk every collection that has declared refs, load its records,
   * and report any reference whose target id is missing. Modes are
   * reported alongside each violation so the caller can distinguish
   * "this is a warning the user asked for" from "this should never
   * have happened" (strict violations produced by out-of-band
   * writes).
   *
   * Returns `{ violations: [...] }` instead of throwing — the whole
   * point of `checkIntegrity()` is to surface a list for display
   * or repair, not to fail noisily.
   */
  async checkIntegrity(): Promise<{ violations: RefViolation[] }> {
    const violations: RefViolation[] = []
    for (const [collectionName, refs] of this.deps.refRegistry.entries()) {
      const coll = this.deps.collection<Record<string, unknown>>(collectionName)
      const records = await coll.list()
      for (const record of records) {
        const recId = (record['id'] as string | undefined) ?? '<unknown>'
        for (const [field, descriptor] of Object.entries(refs)) {
          const rawId = record[field]
          if (rawId === null || rawId === undefined) continue
          const target = this.deps.collection<Record<string, unknown>>(descriptor.target)

          // Array ref: report one violation per dangling element.
          if (isRefArray(descriptor)) {
            if (!Array.isArray(rawId)) {
              violations.push({ collection: collectionName, id: recId, field, refTo: descriptor.target, refId: rawId, mode: descriptor.mode })
              continue
            }
            for (const el of rawId) {
              if (typeof el !== 'string' && typeof el !== 'number') {
                violations.push({ collection: collectionName, id: recId, field, refTo: descriptor.target, refId: el, mode: descriptor.mode })
                continue
              }
              if (!(await target.get(String(el)))) {
                violations.push({ collection: collectionName, id: recId, field, refTo: descriptor.target, refId: el, mode: descriptor.mode })
              }
            }
            continue
          }

          // Non-scalar ref values are flagged as a violation rather
          // than thrown — `checkIntegrity` is a "report what's wrong"
          // tool, not a "block on first failure" tool. The thrown
          // version lives in `enforceRefsOnPut`.
          if (typeof rawId !== 'string' && typeof rawId !== 'number') {
            violations.push({
              collection: collectionName,
              id: recId,
              field,
              refTo: descriptor.target,
              refId: rawId,
              mode: descriptor.mode,
            })
            continue
          }
          const refId = String(rawId)
          const exists = await target.get(refId)
          if (!exists) {
            violations.push({
              collection: collectionName,
              id: recId,
              field,
              refTo: descriptor.target,
              refId: rawId,
              mode: descriptor.mode,
            })
          }
        }
      }
    }

    // Managed link sets: a link row whose endpoint no longer exists
    // is an orphan (the common 'warn'-mode outcome). Report one violation per
    // dangling endpoint, field 'a'/'b', mode = the link's onDelete policy.
    for (const [name, spec] of this.deps.linkRegistry) {
      const linkColl = linkCollectionName(name)
      const rows = await this.deps.links(name).list()
      for (const row of rows) {
        const rowKey = linkRowKey(row.a, row.b)
        if ((await this.deps.collection(spec.a).get(row.a)) === null) {
          violations.push({ collection: linkColl, id: rowKey, field: 'a', refTo: spec.a, refId: row.a, mode: spec.onDelete ?? 'cascade' })
        }
        if ((await this.deps.collection(spec.b).get(row.b)) === null) {
          violations.push({ collection: linkColl, id: rowKey, field: 'b', refTo: spec.b, refId: row.b, mode: spec.onDelete ?? 'cascade' })
        }
      }
    }
    return { violations }
  }
}
