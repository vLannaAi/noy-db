/**
 * Cover service — barrel export. (Formerly "public envelope"; the
 * old names remain as deprecated aliases for one pre-release window.)
 *
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md
 *
 * @module
 */
export type {
  Cover,
  CoverText,
  CoverSchema,
  CoverField,
  ResolvedCoverSchema,
} from './types.js'
export {
  COVER_FIELDS,
  DEFAULT_COVER_SCHEMA,
  resolveSchema,
} from './types.js'

export type { SetCoverInput } from './schema.js'
export { validateCoverInput, isCover } from './schema.js'

export {
  loadCover,
  saveCover,
  readCover,
  resolveLocale,
  pickLocale,
  COVER_RECORD_ID,
} from './storage.js'

// ─── Deprecated aliases (#799 public-envelope → cover; remove after one pre-release window) ───
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
} from './types.js'
export type { SetPublicEnvelopeInput } from './schema.js'
export { validatePublicEnvelopeInput, isPublicEnvelope } from './schema.js'
export {
  loadPublicEnvelope,
  savePublicEnvelope,
  readPublicEnvelope,
  PUBLIC_ENVELOPE_RECORD_ID,
} from './storage.js'
