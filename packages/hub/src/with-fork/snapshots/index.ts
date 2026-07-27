export { withSnapshots } from './active.js'
export type { WithSnapshotsOptions } from './active.js'
export type { SnapshotsStrategy, SnapshotMeta, RetentionPolicy } from './strategy.js'
export type { SnapshotPolicy, SnapshotMode } from './policy.js'
export { SnapshotNotFoundError } from '../../kernel/errors.js'

/** The un-opted-in stub for this service — exported so callers can compare against it (#844). */
export { NO_SNAPSHOTS } from './strategy.js'
