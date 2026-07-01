/**
 * Enable the atomic-sequence capability.
 * Pass to `createNoydb({ sequenceStrategy: withSequence() })` to make
 * `vault.sequence('name').next()` / `.peek()` / `.seedTo()` live. The
 * {@link SequenceStore} CAS engine is statically imported here, so it is pulled
 * into the bundle only when `withSequence()` is referenced (the floor never
 * imports it).
 */
import type { SequenceStrategy } from './strategy.js'
import { SequenceStore } from './index.js'

export function withSequence(): SequenceStrategy {
  return {
    createStore(opts) {
      return new SequenceStore(opts)
    },
  }
}
