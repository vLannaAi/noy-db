/**
 * Strategy seam for the optional consent-audit subsystem. Core
 * imports `ConsentStrategy` as a TYPE-ONLY symbol and `NO_CONSENT`
 * as a tiny runtime stub.
 *
 * `writeConsentEntry` / `loadConsentEntries` are only reachable from
 * `withConsent()` in `./active.ts`, exported through
 * `@noy-db/hub/consent`. Applications without a consent scope ship
 * none of the ~194 LOC.
 *
 * @internal
 */

import type { NoydbStore } from '../types.js'
import type {
  ConsentAuditEntry,
  ConsentAuditFilter,
} from './consent.js'

/**
 * @internal
 */
export interface ConsentStrategy {
  /**
   * Record one consent audit entry. No-op under NO_CONSENT.
   */
  write(
    adapter: NoydbStore,
    vault: string,
    encrypted: boolean,
    entry: Omit<ConsentAuditEntry, 'id' | 'timestamp'>,
    getDEK: (collectionName: string) => Promise<CryptoKey>,
  ): Promise<void>

  /**
   * Read filtered consent entries. Returns `[]` under NO_CONSENT.
   */
  read(
    adapter: NoydbStore,
    vault: string,
    encrypted: boolean,
    getDEK: (collectionName: string) => Promise<CryptoKey>,
    filter?: ConsentAuditFilter,
  ): Promise<ConsentAuditEntry[]>
}

/**
 * No-consent stub. `write` is a no-op (returns a resolved promise);
 * `read` returns `[]`. Consumers get a consistent API surface without
 * pulling the consent module into the bundle.
 *
 * @internal
 */
export const NO_CONSENT: ConsentStrategy = {
  async write() {},
  async read() { return [] },
}
