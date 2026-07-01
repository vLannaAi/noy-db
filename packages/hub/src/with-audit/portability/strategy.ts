/**
 * Portability capability strategy — the six on-demand data-sovereignty methods
 * the vault's `UserApi` routes through (`exportAccessibleData` /
 * `withdrawAccessibleData` / `requestWithdrawal` / `listWithdrawalRequests` /
 * `approveWithdrawal` / `rejectWithdrawal`). The active engine
 * ({@link withPortability}) dynamically imports the export/withdraw/request
 * cores (keeping them reachable only via opt-in); {@link NO_PORTABILITY} throws.
 * The Vault always injects the closures the UserApi calls; they delegate here,
 * so an un-opted-in caller hits `NO_PORTABILITY`'s throw.
 * @internal
 */
import type { Vault } from '../../kernel/vault.js'
import type { ExportAccessibleOptions } from './export-accessible.js'
import type { WithdrawAccessibleOptions, WithdrawResult } from './withdraw-accessible.js'
import type {
  RequestWithdrawalOptions,
  RequestWithdrawalResult,
  WithdrawalRequest,
  WithdrawalRequestStatus,
  ApproveWithdrawalOptions,
  RejectWithdrawalOptions,
} from './request-withdrawal.js'
import { PortabilityNotEnabledError } from '../../kernel/errors.js'

export interface PortabilityStrategy {
  exportAccessibleData(vault: Vault, opts: ExportAccessibleOptions): Promise<Uint8Array>
  withdrawAccessibleData(vault: Vault, opts: WithdrawAccessibleOptions): Promise<WithdrawResult>
  requestWithdrawal(vault: Vault, opts: RequestWithdrawalOptions): Promise<RequestWithdrawalResult>
  listWithdrawalRequests(vault: Vault, opts: { status?: WithdrawalRequestStatus }): Promise<WithdrawalRequest[]>
  approveWithdrawal(vault: Vault, requestId: string, opts: ApproveWithdrawalOptions): Promise<WithdrawResult>
  rejectWithdrawal(vault: Vault, requestId: string, opts: RejectWithdrawalOptions): Promise<WithdrawalRequest>
}

/**
 * No-op stub — the floor default. Every capability method throws
 * {@link PortabilityNotEnabledError}; opt in with
 * `portabilityStrategy: withPortability()` in createNoydb. @internal
 */
export const NO_PORTABILITY: PortabilityStrategy = {
  async exportAccessibleData() { throw new PortabilityNotEnabledError() },
  async withdrawAccessibleData() { throw new PortabilityNotEnabledError() },
  async requestWithdrawal() { throw new PortabilityNotEnabledError() },
  async listWithdrawalRequests() { throw new PortabilityNotEnabledError() },
  async approveWithdrawal() { throw new PortabilityNotEnabledError() },
  async rejectWithdrawal() { throw new PortabilityNotEnabledError() },
}
