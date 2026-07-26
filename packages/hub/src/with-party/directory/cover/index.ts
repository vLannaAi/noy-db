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
  JsonValue,
  ResolvedCoverSchema,
} from './types.js'
export {
  COVER_FIELDS,
  DEFAULT_COVER_SCHEMA,
  resolveSchema,
} from './types.js'

export type { SetCoverInput } from './schema.js'
export { validateCoverInput, isCover } from './schema.js'

export { mergeCustom, validateCoverSize } from './custom.js'

export {
  loadCover,
  saveCover,
  readCover,
  resolveLocale,
  pickLocale,
  COVER_RECORD_ID,
} from './storage.js'
