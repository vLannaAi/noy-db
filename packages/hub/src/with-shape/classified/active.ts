import type { ClassifiedStrategy } from './strategy.js'

/** Opt-in factory: enables reveal (and, in stage 2, verify/matchGroup). */
export function withClassified(): ClassifiedStrategy {
  return {
    async reveal(ctx, id, field) {
      const { revealField } = await import('./reveal.js')
      return revealField(ctx, id, field)
    },
  }
}
