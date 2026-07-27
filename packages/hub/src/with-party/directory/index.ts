/**
 * User-list visibility — barrel export for the
 * `@noy-db/hub/directory` surface.
 *
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/user-envelope.md → Directory visibility
 *
 * @module
 */
export type { DirectoryConfig, UserVisibility } from './types.js'
// #843 C3b — the user-envelope sub-cluster lives under this directory and had no
// home but the root barrel.
export {
  loadUserEnvelope,
  saveUserEnvelope,
  deleteUserEnvelope,
  listUserEnvelopeIds,
} from './user-envelope/storage.js'
export { UserApi } from './user-envelope/api.js'
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
