/**
 * `@noy-db/hub/portability` — data-sovereignty (export + withdrawal) capability.
 *
 * Opt in with `createNoydb({ portabilityStrategy: withPortability() })` to
 * enable the `vault.user.*` portability surface: `exportMyAccessibleData`,
 * `unilateralWithdrawal`, `requestWithdrawal`, `listWithdrawalRequests`,
 * `approveWithdrawal`, `rejectWithdrawal`. Without it every one throws
 * `PortabilityNotEnabledError` and the export/withdraw/request engines stay out
 * of the floor bundle.
 *
 * @module
 */
export { withPortability } from './active.js'
export { NO_PORTABILITY, type PortabilityStrategy } from './strategy.js'
export { PortabilityNotEnabledError } from '../../kernel/errors.js'
export type { ExportAccessibleOptions } from './export-accessible.js'
export type { WithdrawAccessibleOptions, WithdrawResult } from './withdraw-accessible.js'
export type {
  RequestWithdrawalOptions,
  RequestWithdrawalResult,
  WithdrawalRequest,
  WithdrawalRequestStatus,
  ApproveWithdrawalOptions,
  RejectWithdrawalOptions,
} from './request-withdrawal.js'
