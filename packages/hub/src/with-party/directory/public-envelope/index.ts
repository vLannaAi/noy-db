/**
 * Public envelope service — barrel export.
 *
 * @see docs/services/public-envelope.md
 *
 * @module
 */
export type {
  PublicEnvelope,
  PublicEnvelopeText,
  PublicEnvelopeSchema,
  PublicEnvelopeField,
  ResolvedPublicEnvelopeSchema,
} from './types.js'
export {
  PUBLIC_ENVELOPE_FIELDS,
  DEFAULT_PUBLIC_ENVELOPE_SCHEMA,
  resolveSchema,
} from './types.js'

export type { SetPublicEnvelopeInput } from './schema.js'
export { validatePublicEnvelopeInput, isPublicEnvelope } from './schema.js'

export {
  loadPublicEnvelope,
  savePublicEnvelope,
  readPublicEnvelope,
  resolveLocale,
  pickLocale,
  PUBLIC_ENVELOPE_RECORD_ID,
} from './storage.js'
