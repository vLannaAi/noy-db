/**
 * Per-collection write gate (#245). Holds the (async) update decision
 * computed at registration; `Collection.put`/`delete` await it before
 * writing and throw the strategy's rejection error.
 *
 * Detection FAILURE (the promise rejecting) is deliberately NOT a write
 * block — schema detection is a fingerprint safety net, not a correctness
 * invariant (matches how persisted-schema write failures are swallowed).
 * Only an explicit `reject` decision blocks writes.
 */
import type { UpdateDecision } from './types.js'

export class SchemaUpdateGate {
  readonly #decision: Promise<UpdateDecision | null>

  constructor(decision: Promise<UpdateDecision>) {
    // Swallow detection failures into a non-blocking null.
    this.#decision = decision.catch(() => null)
  }

  async assertWritable(): Promise<void> {
    const decision = await this.#decision
    if (decision && decision.action === 'reject') {
      throw decision.error
    }
    // 'cutover' write-gating is handled by #232's coordinatedCutover.
  }
}
