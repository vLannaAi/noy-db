/** Classified fields barrel — descriptors, presets, resolver, errors (stage 1). @module */
export type {
  ClassifiedStorage, ClassifiedList, ClassifiedRider,
  ClassifiedFieldSpec, ClassifiedGroup, ClassifiedEntry,
} from './descriptor.js'
export { isClassifiedFieldSpec, isClassifiedGroup } from './descriptor.js'
export { resolveClassifiedFields, type ResolvedClassified } from './resolve.js'
export { classified } from './presets.js'
export { luhnCheck } from './validators.js'
export { enforceClassifiedWrite } from './write.js'
export { ClassifiedConfigError, ClassifiedNeverStoredError, ClassifiedValidationError, ClassifiedRevealError, ClassifiedVerifyError, ClassifiedRotationError } from './errors.js'
export { withClassified } from './active.js'
export { NO_CLASSIFIED, type ClassifiedStrategy, type ClassifiedRevealCtx } from './strategy.js'
export type { ClassifiedVerdict, ClassifiedVerifyCtx } from './strategy.js'
