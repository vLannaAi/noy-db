/**
 * `@noy-db/hub/util` — pure helpers that don't belong to any single
 * subsystem and have no dependency on the keyring, ledger, or stores.
 *
 * Currently:
 *   - {@link sanitizeFilename} — target-profile aware filename safety
 *     for export-blobs sites and any other place where adopters write
 *     a record-supplied filename to a real storage destination.
 *
 * @module
 */

export { sanitizeFilename } from './sanitize-filename.js'
export type {
  FilenameProfile,
  SanitizeFilenameOptions,
} from './sanitize-filename.js'
