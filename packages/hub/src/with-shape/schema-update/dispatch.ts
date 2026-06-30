/** Ordered strategy evaluation: first non-`allow` decision wins. */
import type { SchemaDelta, SchemaUpdateStrategy, UpdateContext, UpdateDecision } from './types.js'

export async function evaluateStrategies(
  delta: SchemaDelta,
  strategies: readonly SchemaUpdateStrategy[],
  ctx: UpdateContext,
): Promise<UpdateDecision> {
  for (const strategy of strategies) {
    const decision = await strategy.onSchemaDelta(delta, ctx)
    if (decision.action !== 'allow') return decision
  }
  return { action: 'allow' }
}
