export type {
  SchemaDelta,
  FieldChange,
  UpdateContext,
  UpdateDecision,
  TransformFn,
  SchemaUpdateStrategy,
} from './types.js'
export { computeSchemaDelta } from './delta.js'
export { evaluateStrategies } from './dispatch.js'
export { blindUpdate, additiveOnly, lockSchema } from './strategies.js'
export { coordinatedCutover } from './cutover.js'
export { SchemaUpdateGate } from './gate.js'
// #843 C3b — completes the cluster.
export type { FenceDoc } from './fence.js'
