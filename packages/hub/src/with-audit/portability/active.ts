/**
 * Enable the portability capability.
 * Pass to `createNoydb({ portabilityStrategy: withPortability() })` to make a
 * vault's `user.exportMyAccessibleData` / `user.unilateralWithdrawal` /
 * `user.requestWithdrawal` / `user.listWithdrawalRequests` /
 * `user.approveWithdrawal` / `user.rejectWithdrawal` methods live. The
 * export/withdraw/request engines are dynamically imported here, so they stay
 * reachable only via opt-in.
 */
import type { PortabilityStrategy } from './strategy.js'

export function withPortability(): PortabilityStrategy {
  return {
    async exportAccessibleData(vault, opts) {
      const { exportAccessibleData } = await import('./export-accessible.js')
      return exportAccessibleData(vault, opts)
    },
    async withdrawAccessibleData(vault, opts) {
      const { withdrawAccessibleData } = await import('./withdraw-accessible.js')
      return withdrawAccessibleData(vault, opts)
    },
    async requestWithdrawal(vault, opts) {
      const { requestWithdrawal } = await import('./request-withdrawal.js')
      return requestWithdrawal(vault, opts)
    },
    async listWithdrawalRequests(vault, opts) {
      const { listWithdrawalRequests } = await import('./request-withdrawal.js')
      return listWithdrawalRequests(vault, opts)
    },
    async approveWithdrawal(vault, requestId, opts) {
      const { approveWithdrawal } = await import('./request-withdrawal.js')
      return approveWithdrawal(vault, requestId, opts)
    },
    async rejectWithdrawal(vault, requestId, opts) {
      const { rejectWithdrawal } = await import('./request-withdrawal.js')
      return rejectWithdrawal(vault, requestId, opts)
    },
  }
}
