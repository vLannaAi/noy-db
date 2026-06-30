/**
 * Active consent strategy. Calling `withConsent()` returns a
 * `ConsentStrategy` that delegates to the real
 * `writeConsentEntry` / `loadConsentEntries` functions. Only
 * reachable through the `@noy-db/hub/consent` subpath.
 */

import { writeConsentEntry, loadConsentEntries } from './consent.js'
import type { ConsentStrategy } from './strategy.js'

/**
 * Build the default consent strategy. Pass into
 * `createNoydb({ consentStrategy: withConsent() })` to enable
 * per-operation audit writes into the reserved `_consent_audit`
 * collection.
 */
export function withConsent(): ConsentStrategy {
  return {
    write: writeConsentEntry,
    read: loadConsentEntries,
  }
}
