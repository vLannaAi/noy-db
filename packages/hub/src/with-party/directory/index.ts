/**
 * User-list visibility — barrel export for the
 * `@noy-db/hub/directory` surface.
 *
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/user-envelope.md → Directory visibility
 *
 * @module
 */
export type { DirectoryConfig, UserVisibility } from './types.js'
export {
  readDirectoryConfig,
  persistDirectoryConfig,
  META_COLLECTION,
  DIRECTORY_RECORD_ID,
} from './storage.js'
export {
  readUserVisibility,
  persistUserVisibility,
  deleteUserVisibility,
  visibilityRecordId,
  VISIBILITY_RECORD_PREFIX,
} from './visibility.js'
