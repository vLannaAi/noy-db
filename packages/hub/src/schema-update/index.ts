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
export { SchemaUpdateGate } from './gate.js'
