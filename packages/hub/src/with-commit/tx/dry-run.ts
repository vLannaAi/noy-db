/**
 * Dry-run transactions. Runs the tx body to STAGE ops, then builds
 * the directly-affected diff (before = current committed via collection.get,
 * after = staged record) and collects guard violations — without executing
 * phase 2. No adapter writes, no write-hooks, no commit. MV/derivation
 * cascade is NOT simulated (v2). Mirrors the guard loop in
 * `Collection.putInternal` — keep the two in sync.
 */
import type { Noydb } from '../../kernel/noydb.js'
import { TxContext, type StagedOp } from './transaction.js'
import type { GuardExecutor as GuardExecutorType } from '../../with-audit/guards/executor.js'

export interface AffectedDocument {
  readonly vault: string
  readonly op: 'create' | 'update' | 'delete'
  readonly collection: string
  readonly docId: string
  readonly before: unknown // current committed record; null when creating
  readonly after: unknown // staged record; null when deleting
}

export interface GuardViolation {
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly message: string
}

export interface DryRunResult {
  readonly affected: ReadonlyArray<AffectedDocument>
  readonly guardViolations: ReadonlyArray<GuardViolation>
}

const SEP = ' '
const keyOf = (op: StagedOp) => `${op.vaultName}${SEP}${op.collectionName}${SEP}${op.id}`

export async function runDryRun(
  db: Noydb,
  fn: (tx: TxContext) => unknown,
): Promise<DryRunResult> {
  const ctx = new TxContext(db)
  await fn(ctx) // stage ops (reads see staged writes via TxCollection); nothing committed

  // Dedup by (vault, collection, id) — last staged op wins.
  const lastOp = new Map<string, StagedOp>()
  for (const op of ctx._ops) lastOp.set(keyOf(op), op)

  const affected: AffectedDocument[] = []
  const guardViolations: GuardViolation[] = []

  for (const op of lastOp.values()) {
    const v = db.vault(op.vaultName)
    const coll = v.collection(op.collectionName)
    const before = await coll.get(op.id)

    if (op.type === 'delete') {
      affected.push({ vault: op.vaultName, op: 'delete', collection: op.collectionName, docId: op.id, before, after: null })
      continue
    }

    const after = op.record ?? null
    affected.push({
      vault: op.vaultName,
      op: before === null ? 'create' : 'update',
      collection: op.collectionName,
      docId: op.id,
      before,
      after,
    })

    // Guard violations — run the SAME checks Collection.putInternal does,
    // with the SAME ctx (existing + read-only facade + userId + role), but
    // collect the first thrown error instead of aborting.
    const registry = v._getGuardRegistry()
    if (!registry) continue
    const guards = registry.guardsFor(op.collectionName)
    if (guards.length === 0) continue
    const facade = v._getReadOnlyFacade()
    if (!facade) continue
    const gctx = { existing: before as Record<string, unknown> | null, vault: facade, userId: v.userId, role: v.role }
    try {
      await registry.runChecks(op.collectionName, after as Record<string, unknown>, gctx)
      const { GuardExecutor } = (await import('../../with-audit/guards/executor.js')) as { GuardExecutor: typeof GuardExecutorType }
      for (const g of guards) {
        await GuardExecutor.checkFrozenFields(g, op.id, before as Record<string, unknown> | null, after as Record<string, unknown>)
      }
    } catch (err) {
      guardViolations.push({
        vault: op.vaultName,
        collection: op.collectionName,
        docId: op.id,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { affected, guardViolations }
}
