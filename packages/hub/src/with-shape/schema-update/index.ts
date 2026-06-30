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
