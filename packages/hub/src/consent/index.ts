/**
 * @noy-db/hub/consent — opt-in consent-audit subsystem.
 *
 * @category capability
 *
 * Records per-operation consent entries into a reserved
 * `_consent_audit` collection when a consent scope is active.
 * Applications that don't need GDPR-style audit trails can omit this
 * subpath and skip the ~194 LOC.
 */

export { withConsent } from './active.js'
export type { ConsentStrategy } from './strategy.js'

export {
  CONSENT_AUDIT_COLLECTION,
  writeConsentEntry,
  loadConsentEntries,
} from './consent.js'
export type {
  ConsentContext,
  ConsentOp,
  ConsentAuditEntry,
  ConsentAuditFilter,
} from './consent.js'
